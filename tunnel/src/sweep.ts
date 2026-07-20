import { VirtualClock } from "./clock.ts";
import { Outbox } from "./outbox.ts";
import { mulberry32, seededIds } from "./random.ts";
import { FakeServer, FaultyTransport } from "./transport.ts";
import type { FaultStats } from "./transport.ts";
import { OutboxQueue } from "./queue.ts";

export interface SweepResult {
  seed: number;
  ok: boolean;
  messages: number;
  /** Which faults actually fired, so a run can prove it was attacked. */
  stats: FaultStats;
  /** Null when every invariant held. */
  failure: string | null;
}

/** Virtual milliseconds. The link is forced up well before this, so a run that
 *  has not drained by the horizon is a real bug, not an impatient test. */
const HORIZON_MS = 20 * 60 * 1000;
const LINK_RESTORED_MS = 60 * 1000;

/**
 * One adversarial run. Every decision — fault probabilities, when the link
 * flaps, when messages are sent, how long each hop takes — is drawn from the
 * seed, so a failure reproduces exactly from the seed alone.
 */
export function runOne(seed: number): SweepResult {
  const clock = new VirtualClock();
  const rng = mulberry32(seed);
  const server = new FakeServer();

  const transport = new FaultyTransport({
    clock,
    rng,
    server,
    faults: {
      // Deliberately drawn wide enough that a one-way hop can exceed the 2000ms
      // first-attempt ack timeout. A range that stays comfortably inside it
      // would never exercise the slow-but-alive link, which is the regime a
      // fixed timeout livelocks in — the sweep would be tuned to pass.
      latencyMs: 20 + Math.floor(rng() * 1500),
      jitterMs: Math.floor(rng() * 200),
      dropFrame: rng() * 0.4,
      dropAck: rng() * 0.4,
      duplicate: rng() * 0.3,
    },
  });

  const outbox = Outbox.open();
  const queue = new OutboxQueue({
    outbox,
    transport,
    clock,
    rng,
    ackTimeoutMs: 2000,
    mintId: seededIds(rng),
  });

  const link = (up: boolean): void => {
    transport.setOnline(up);
    queue.onConnectivityChange(up);
  };

  const sent: string[] = [];
  const count = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < count; i++) {
    const body = `m${i + 1}`;
    clock.setTimeout(() => {
      sent.push(body);
      queue.send(body);
    }, Math.floor(rng() * 30000));
  }

  // Flap the link on a schedule the queue cannot anticipate.
  link(rng() < 0.5);
  for (let i = 0; i < 6; i++) {
    const at = Math.floor(rng() * 45000);
    const up = rng() < 0.5;
    clock.setTimeout(() => link(up), at);
  }
  // Then give it a working network and enough time to finish.
  clock.setTimeout(() => link(true), LINK_RESTORED_MS);
  clock.runUntilIdle(HORIZON_MS);

  const fail = (why: string): SweepResult => ({
    seed,
    ok: false,
    messages: sent.length,
    stats: transport.stats,
    failure: why,
  });

  if (server.log.length !== sent.length) {
    return fail(`expected ${sent.length} messages on the server, saw ${server.log.length}`);
  }

  const delivered = server.log.map((e) => e.body);
  for (let i = 0; i < sent.length; i++) {
    if (delivered[i] !== sent[i]) {
      return fail(`order broke at index ${i}: sent ${sent.join(",")}, server saw ${delivered.join(",")}`);
    }
  }

  const ids = new Set(server.log.map((e) => e.clientId));
  if (ids.size !== server.log.length) return fail("the server log contains a duplicated client id");

  for (const row of outbox.all()) {
    if (row.state !== "acked") return fail(`message ${row.clientId} never reached 'acked'`);
    if (!row.serverId) return fail(`message ${row.clientId} acked without a reconciled server id`);
    const onServer = server.log.find((e) => e.clientId === row.clientId);
    if (!onServer) return fail(`message ${row.clientId} claims delivery the server cannot corroborate`);
    if (row.serverId !== `s-${onServer.serverSeq}`) {
      return fail(`message ${row.clientId} reconciled to ${row.serverId}, server says s-${onServer.serverSeq}`);
    }
  }

  return { seed, ok: true, messages: sent.length, stats: transport.stats, failure: null };
}

export interface SweepSummary {
  total: number;
  passed: number;
  messages: number;
  /** Faults fired across the whole sweep. Zero anywhere means the adversary slept. */
  stats: FaultStats;
  failures: SweepResult[];
}

export function runSweep(total: number): SweepSummary {
  const failures: SweepResult[] = [];
  const stats: FaultStats = { framesDropped: 0, acksDropped: 0, duplicated: 0, connectionsLost: 0 };
  let passed = 0;
  let messages = 0;

  for (let seed = 1; seed <= total; seed++) {
    const result = runOne(seed);
    messages += result.messages;
    stats.framesDropped += result.stats.framesDropped;
    stats.acksDropped += result.stats.acksDropped;
    stats.duplicated += result.stats.duplicated;
    stats.connectionsLost += result.stats.connectionsLost;
    if (result.ok) passed++;
    else failures.push(result);
  }

  return { total, passed, messages, stats, failures };
}
