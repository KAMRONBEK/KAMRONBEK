import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VirtualClock } from "../src/clock.ts";
import { Outbox } from "../src/outbox.ts";
import { mulberry32, seededIds } from "../src/random.ts";
import { OutboxQueue } from "../src/queue.ts";
import { CLEAN, FakeServer, FaultyTransport } from "../src/transport.ts";
import { runSweep } from "../src/sweep.ts";
import type { Ack, Frame, TraceEvent, Transport } from "../src/types.ts";

export const SWEEP_SEEDS = 200;

test("no loss, no duplicates, order preserved across the fault sweep", () => {
  const summary = runSweep(SWEEP_SEEDS);

  // Report every failing seed — each one is a complete, replayable repro.
  const detail = summary.failures.map((f) => `  seed ${f.seed}: ${f.failure}`).join("\n");
  assert.equal(summary.passed, summary.total, `\n${summary.failures.length} seed(s) broke an invariant:\n${detail}`);
  assert.ok(summary.messages > 0, "the sweep sent no messages, so it proved nothing");
});

test("the sweep actually fires every fault it claims to inject", () => {
  // Without this, the whole fault injector can be turned into a no-op and the
  // suite stays green — a sweep that proves delivery over a perfect network.
  const { stats } = runSweep(SWEEP_SEEDS);

  assert.ok(stats.framesDropped > 0, "no frame was ever dropped before reaching the server");
  assert.ok(stats.acksDropped > 0, "no ack was ever lost, so dedupe was never actually needed");
  assert.ok(stats.duplicated > 0, "the server was never sent a duplicate frame");
  assert.ok(stats.connectionsLost > 0, "no connection ever died mid-flight");
});

test("a lost ack causes a resend, and the resend does not duplicate", () => {
  const clock = new VirtualClock();
  const server = new FakeServer();

  // The server accepts the frame; the ack never makes it back. This is the
  // fault that punishes any queue whose retry is not idempotent.
  class DropsFirstAck implements Transport {
    #dropped = false;
    send(frame: Frame, onAck: (ack: Ack) => void): void {
      clock.setTimeout(() => {
        const ack = server.receive(frame);
        if (!this.#dropped) {
          this.#dropped = true;
          return;
        }
        onAck(ack);
      }, 50);
    }
  }

  const outbox = Outbox.open();
  const queue = new OutboxQueue({
    outbox,
    transport: new DropsFirstAck(),
    clock,
    rng: mulberry32(1),
    ackTimeoutMs: 500,
  });

  const clientId = queue.send("only once");
  clock.runUntilIdle(30000);

  assert.equal(server.log.length, 1, "the server appended the message twice");
  assert.equal(server.log[0].body, "only once");
  assert.equal(outbox.all()[0].state, "acked");
  assert.equal(queue.serverIdFor(clientId), "s-1", "optimistic id was not reconciled to the server id");
  assert.ok(outbox.all()[0].attempts >= 2, "expected a resend after the ack was lost");
});

test("messages queued before a crash survive it and flush in the original order", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunnel-"));
  const dbPath = join(dir, "outbox.db");

  try {
    // Session one: no network at all, then the process dies mid-outage.
    {
      const clock = new VirtualClock();
      const outbox = Outbox.open(dbPath);
      const server = new FakeServer();
      const transport = new FaultyTransport({ clock, rng: mulberry32(7), server, faults: CLEAN });
      // transport stays offline for the whole session
      const queue = new OutboxQueue({ outbox, transport, clock, rng: mulberry32(7), mintId: seededIds(mulberry32(7)) });

      queue.send("first");
      queue.send("second");
      queue.send("third");
      clock.runUntilIdle(10000);

      assert.equal(server.log.length, 0, "nothing should have reached the server");
      assert.equal(outbox.queuedCount(), 3);
      outbox.close(); // the process dies here
    }

    // Session two: same database file, a working network.
    {
      const clock = new VirtualClock();
      const outbox = Outbox.open(dbPath);
      assert.equal(outbox.queuedCount(), 3, "the outbox did not survive the restart");

      const server = new FakeServer();
      const transport = new FaultyTransport({ clock, rng: mulberry32(8), server, faults: CLEAN });
      const queue = new OutboxQueue({ outbox, transport, clock, rng: mulberry32(8), mintId: seededIds(mulberry32(8)) });

      transport.setOnline(true);
      queue.onConnectivityChange(true);
      clock.runUntilIdle(60000);

      assert.deepEqual(
        server.log.map((e) => e.body),
        ["first", "second", "third"],
        "messages recovered from disk were delivered out of order",
      );
      assert.equal(outbox.queuedCount(), 0);
      outbox.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never more than one attempt outstanding, however hard the link flaps", () => {
  // Head-of-line sending is what bounds load on reconnect: a phone coming back
  // from an outage with 40 queued messages must not open 40 attempts at once.
  // Ordering survives without this guard (the outbox always hands back its
  // oldest unacked row), so it needs asserting on its own terms.
  for (let seed = 1; seed <= 50; seed++) {
    const clock = new VirtualClock();
    const rng = mulberry32(seed);
    const server = new FakeServer();
    const transport = new FaultyTransport({
      clock,
      rng,
      server,
      faults: { latencyMs: 30, jitterMs: 30, dropFrame: 0.3, dropAck: 0.3, duplicate: 0.2 },
    });
    const outbox = Outbox.open();

    let outstanding = 0;
    let peak = 0;
    const queue = new OutboxQueue({
      outbox,
      transport,
      clock,
      rng,
      mintId: seededIds(mulberry32(seed)),
      onEvent: (e) => {
        if (e.kind === "sent") outstanding++;
        if (e.kind === "ack" || e.kind === "send-failed") outstanding--;
        peak = Math.max(peak, outstanding);
      },
    });

    const link = (up: boolean): void => {
      transport.setOnline(up);
      queue.onConnectivityChange(up);
    };

    link(true);
    for (let i = 0; i < 8; i++) queue.send(`m${i + 1}`);
    for (let i = 0; i < 8; i++) clock.setTimeout(() => link(rng() < 0.5), Math.floor(rng() * 20000));
    clock.setTimeout(() => link(true), 40000);
    clock.runUntilIdle(600000);

    assert.equal(peak, 1, `seed ${seed}: ${peak} attempts were outstanding at once`);
    assert.equal(server.log.length, 8, `seed ${seed}: expected all 8 delivered`);
  }
});

test("reconnecting collapses the backoff instead of waiting it out", () => {
  // Eventual delivery is not enough here. A phone leaving a tunnel with a live
  // radio and a full outbox must not sit out the delay it accrued against the
  // dead link — so this asserts latency, which a delivery-only test cannot see.
  const clock = new VirtualClock();
  const rng = mulberry32(3);
  const server = new FakeServer();
  const transport = new FaultyTransport({ clock, rng, server, faults: CLEAN });
  const outbox = Outbox.open();
  const events: TraceEvent[] = [];
  const queue = new OutboxQueue({
    outbox,
    transport,
    clock,
    rng,
    mintId: seededIds(mulberry32(3)),
    onEvent: (e) => events.push(e),
  });

  // No link at all, long enough for the backoff to climb to its ceiling.
  queue.send("held");
  clock.runUntilIdle(120000);

  const lastRetry = [...events].reverse().find((e) => e.kind === "retry-scheduled");
  assert.ok(lastRetry, "expected the queue to have backed off while offline");
  assert.equal(outbox.queuedCount(), 1);

  // The radio comes back.
  const connectedAt = clock.now();
  transport.setOnline(true);
  queue.onConnectivityChange(true);
  clock.runUntilIdle(connectedAt + 60000);

  const firstSend = events.find((e) => e.kind === "sent" && e.t >= connectedAt);
  assert.ok(firstSend, "nothing was sent after the link came back");
  assert.ok(
    firstSend.t - connectedAt <= 50,
    `waited ${firstSend.t - connectedAt}ms after reconnect before retrying; the accrued backoff was not discarded`,
  );
  assert.equal(server.log.length, 1, "the held message never arrived");
});

test("a run is a pure function of its seed", () => {
  const trace = (): string => {
    const clock = new VirtualClock();
    const rng = mulberry32(99);
    const server = new FakeServer();
    const transport = new FaultyTransport({
      clock,
      rng,
      server,
      faults: { latencyMs: 30, jitterMs: 20, dropFrame: 0.3, dropAck: 0.3, duplicate: 0.2 },
    });
    const outbox = Outbox.open();
    const lines: string[] = [];
    const queue = new OutboxQueue({
      outbox,
      transport,
      clock,
      rng,
      mintId: seededIds(mulberry32(99)),
      onEvent: (e) => lines.push(`${e.t} ${e.kind} ${e.text}`),
    });

    transport.setOnline(true);
    queue.onConnectivityChange(true);
    queue.send("a");
    queue.send("b");
    clock.runUntilIdle(120000);
    return lines.join("\n");
  };

  assert.equal(trace(), trace(), "the same seed produced two different traces");
});
