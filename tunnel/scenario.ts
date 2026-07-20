import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VirtualClock } from "./src/clock.ts";
import { Outbox } from "./src/outbox.ts";
import { mulberry32, seededIds } from "./src/random.ts";
import { OutboxQueue } from "./src/queue.ts";
import { FakeServer, FaultyTransport } from "./src/transport.ts";
import { runSweep } from "./src/sweep.ts";
import type { TraceEvent } from "./src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/** Seeds are fixed so the committed graphic only changes when behaviour does. */
const SCENARIO_SEED = 4;
const SWEEP_SEEDS = 200;

const FAULTS = { latencyMs: 60, jitterMs: 0, dropFrame: 0, dropAck: 0, duplicate: 0 };

/**
 * The demo run: a phone loses the network mid-send, keeps accepting messages
 * while it has none, backs off, then recovers and flushes. Every number in the
 * graphic comes out of this run — nothing in the renderer is hand-written.
 */
function main(): void {
  const clock = new VirtualClock();
  const rng = mulberry32(SCENARIO_SEED);
  const server = new FakeServer();
  const transport = new FaultyTransport({ clock, rng, server, faults: FAULTS });
  const outbox = Outbox.open();

  const events: TraceEvent[] = [];
  const queue = new OutboxQueue({
    outbox,
    transport,
    clock,
    rng,
    ackTimeoutMs: 2000,
    mintId: seededIds(rng),
    onEvent: (e) => events.push(e),
  });

  const link = (up: boolean): void => {
    transport.setOnline(up);
    queue.onConnectivityChange(up);
  };

  const sent: string[] = [];
  const say = (body: string) => (): void => {
    sent.push(body);
    queue.send(body);
  };

  link(true);
  clock.setTimeout(say("hey"), 200);
  // In flight when the radio dies — the beat a happy-path demo never shows.
  clock.setTimeout(say("on my way"), 860);
  clock.setTimeout(() => link(false), 900);
  clock.setTimeout(say("2 min out"), 1500);
  clock.setTimeout(() => link(true), 8000);
  clock.runUntilIdle(60000);

  const delivered = server.log.map((e) => e.body);
  const uniqueIds = new Set(server.log.map((e) => e.clientId));
  const ordered = delivered.length === sent.length && delivered.every((b, i) => b === sent[i]);

  const lost = sent.length - server.log.length;
  const duplicates = server.log.length - uniqueIds.size;

  if (lost !== 0 || duplicates !== 0 || !ordered) {
    throw new Error(
      `the demo scenario itself broke an invariant — lost ${lost}, duplicates ${duplicates}, ordered ${ordered}`,
    );
  }

  // The same engine, run adversarially. This is where the pass count on the
  // graphic comes from; it is never a literal.
  const sweep = runSweep(SWEEP_SEEDS);
  if (sweep.passed !== sweep.total) {
    throw new Error(`refusing to render: ${sweep.total - sweep.passed} of ${sweep.total} fault runs failed`);
  }

  const ackAt = new Map<string, number>();
  for (const e of events) if (e.kind === "ack" && e.clientId) ackAt.set(e.clientId, e.t);

  const trace = {
    scenario: "the radio dies mid-send, and everything still arrives once, in order",
    seed: SCENARIO_SEED,
    faults: FAULTS,
    events,
    messages: outbox.all().map((row) => ({
      clientId: row.clientId,
      body: row.body,
      enqueuedAt: row.enqueuedAt,
      deliveredAt: ackAt.get(row.clientId) ?? null,
      attempts: row.attempts,
      serverId: row.serverId,
    })),
    summary: {
      sent: sent.length,
      delivered: server.log.length,
      lost,
      duplicates,
      ordered,
      durationMs: events.length ? events[events.length - 1].t : 0,
      sweep: { total: sweep.total, passed: sweep.passed, messages: sweep.messages },
    },
  };

  mkdirSync(join(REPO, "data"), { recursive: true });
  writeFileSync(join(REPO, "data", "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);

  console.log(
    `trace: ${events.length} events, ${sent.length} messages, ${lost} lost, ${duplicates} duplicates\n` +
      `sweep: ${sweep.passed}/${sweep.total} seeds green across ${sweep.messages} messages`,
  );
}

main();
