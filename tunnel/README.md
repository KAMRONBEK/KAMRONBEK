# tunnel

An offline-first message queue, and the deterministic simulator that proves it
behaves. The graphic on my profile is generated from a real run of this code —
every timestamp, every backoff delay and every count on it is output.

```
npm test       # the invariants, across 200 seeded fault runs
npm run trace  # re-runs the demo scenario, writes data/trace.json
npm run render # writes assets/tunnel-{dark,light}.svg from that trace
```

No dependencies. Node 22.18+ for built-in TypeScript type stripping, `node:sqlite`
and `node:test`. There is no install step and no build step.

## The problem

Sending a message when the network is up is not the hard part. The hard part is
the subway tunnel: the radio dies between `send()` and the server's ack, the
user keeps typing, and thirty seconds later everything has to arrive — exactly
once, in the order it was written, with nothing silently dropped.

Three properties, each a design choice rather than an accident of timing:

| Property | Why it holds |
|---|---|
| **No loss** | A message is durable in SQLite before the network is touched. `send()` returns an id, not a promise of delivery. |
| **Order** | Exactly one frame in flight, always the oldest unacked row. Order is a property of the SQL that selects it, not of network timing. |
| **No duplicates** | Ids are minted on the phone and deduped by the server, so retrying after a lost ack is safe by construction. |

Two failure modes that are easy to miss, and are handled deliberately:

- **The ack timeout has to grow with the retries.** Pinned at a constant, a link
  that is merely *slow* — congested cellular with an RTT above the timeout —
  times out every ack it is still waiting for, invalidates it and resends
  forever. The head never clears and nothing behind it moves. The timeout
  doubles per attempt, so the queue converges on the real RTT instead.
- **Reconnecting has to discard the accrued backoff.** Otherwise a phone leaving
  a tunnel sits idle for whatever delay it last scheduled against the dead link
  — up to 30 seconds — with a live radio and a full outbox.

## What it deliberately does not do

It does not gate sending on a connectivity flag. On a phone that flag lies —
captive portals, wifi associated with no route, a socket that is open and
black-holing. The transport's own failure is the only trustworthy signal, so the
queue always attempts and backs off. A connectivity event is a hint to retry
sooner, never permission to try at all.

It also has no attempt cap and no dead-letter path. That is deliberate: dropping
a message after N attempts would contradict the "No loss" row above.

## How it is tested

`src/transport.ts` is an adversary, not a stub. It drops frames before the
server sees them, accepts frames and then loses the ack, delivers the same frame
twice, and kills the connection in the window between send and arrival. Latency
is drawn wide enough that a hop can exceed the first-attempt ack timeout — a
range that stayed comfortably inside it would never exercise the slow-but-alive
link, and the sweep would be tuned to pass.

Runs are deterministic. Virtual time (`src/clock.ts`) and a seeded PRNG
(`src/random.ts`) mean nothing reads the wall clock or `Math.random`, so a run
is a pure function of its seed — a failing seed is a complete, replayable bug
report, and `data/trace.json` is byte-identical between runs. (The rendered SVG
carries a provenance line keyed to the commit, so it is reproducible per commit
rather than across all of them.)

`test/invariants.test.ts` covers:

- **the fault sweep** — 200 seeds, randomized fault probabilities, randomized
  link flapping, asserting no loss, no duplicates, preserved order, and that
  every optimistic id was reconciled to the server id the server actually issued
- **that the injected faults actually fire** — without this the whole adversary
  can be turned into a no-op and the suite stays green, proving only that
  delivery works over a perfect network
- **a lost ack causes a resend, and the resend does not duplicate**
- **messages queued before a crash survive it** — a second `Outbox` is opened
  over the same database file and flushes in the original order
- **at most one attempt outstanding**, however hard the link flaps
- **reconnecting collapses the backoff** — asserted as a *latency* bound after
  the link returns, which a delivery-only test cannot see
- **a run is a pure function of its seed**

### The tests are checked against mutations

A suite that has never failed proves nothing. Each mechanism below was broken
deliberately and the suite re-run; every figure is pasted from that run.

| Mutation | Result |
|---|---|
| Server dedupe disabled | `seed 1: expected 3 messages on the server, saw 7` |
| `head()` ordered `DESC` instead of by `seq` | `seed 1: order broke at index 1: sent m3,m1,m2, server saw m3,m2,m1` |
| Ack timeout pinned to a constant | `seed 2: expected 6 messages on the server, saw 1` — the livelock |
| Frame-drop fault turned into a no-op | Caught by the faults-actually-fire test |
| Reconnect backoff-discard removed | Caught by the reconnect-latency test |
| Single-inflight guard removed | `seed 1: 10 attempts were outstanding at once` |

That last row has a history worth keeping. The first version of this suite had
no test for it, and removing the guard left everything green — because ordering
does **not** depend on it. Ordering comes from the outbox always handing back its
oldest unacked row; the guard bounds *concurrent attempts*, which nothing was
asserting. The mutation that was supposed to prove the ordering test worked
instead proved it was testing the wrong mechanism.

## Layout

```
src/clock.ts      virtual time; deterministic timer ordering
src/random.ts     mulberry32, and seeded client ids for simulated runs
src/outbox.ts     SQLite durability boundary
src/transport.ts  the fake server (dedupe) and the adversarial network
src/queue.ts      backoff, head-of-line sending, reconciliation
src/sweep.ts      one adversarial run, and the seeded sweep over many
scenario.ts       the demo run the graphic is drawn from
```

Client ids default to `crypto.randomUUID()`. The simulator injects a seeded
generator instead, because a run has to replay — but the id has to be unique
across process restarts, since acked rows are kept forever and `client_id` is
`UNIQUE`. A per-session counter would collide on the second launch.
