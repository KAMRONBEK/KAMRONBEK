import type { VirtualClock } from "./clock.ts";
import type { Ack, ClientId, Frame, Transport } from "./types.ts";

/**
 * The server the phone is talking to. Its one job here is to be honest about
 * dedupe: a frame it has already accepted returns the original ack and is NOT
 * appended again. That is the contract the client's retry logic depends on —
 * without it, "resend on lost ack" silently becomes "duplicate every message".
 */
export class FakeServer {
  #seen = new Map<ClientId, Ack>();
  log: { clientId: ClientId; body: string; serverSeq: number }[] = [];

  receive(frame: Frame): Ack {
    const prior = this.#seen.get(frame.clientId);
    if (prior) return prior;

    const serverSeq = this.log.length + 1;
    const ack: Ack = { clientId: frame.clientId, serverId: `s-${serverSeq}`, serverSeq };
    this.log.push({ clientId: frame.clientId, body: frame.body, serverSeq });
    this.#seen.set(frame.clientId, ack);
    return ack;
  }
}

export interface FaultProfile {
  latencyMs: number;
  jitterMs: number;
  /** Frame vanishes before the server sees it. Recovered only by the ack timeout. */
  dropFrame: number;
  /** Server accepts it, ack never arrives. This is the fault that requires dedupe. */
  dropAck: number;
  /** Server receives the same frame twice. Dedupe must absorb it. */
  duplicate: number;
}

/** How many times each fault actually fired. Lets a run prove it was attacked. */
export interface FaultStats {
  framesDropped: number;
  acksDropped: number;
  duplicated: number;
  connectionsLost: number;
}

export const CLEAN: FaultProfile = {
  latencyMs: 40,
  jitterMs: 0,
  dropFrame: 0,
  dropAck: 0,
  duplicate: 0,
};

/**
 * An adversarial network. Every failure mode a real socket has and a happy-path
 * demo never shows: black holes, lost acks, duplicate delivery, and a connection
 * that dies between `send` and arrival.
 */
export class FaultyTransport implements Transport {
  #clock: VirtualClock;
  #rng: () => number;
  #server: FakeServer;
  #faults: FaultProfile;
  #online = false;
  /** Bumped on every connection change, so frames in flight across a drop can be detected. */
  #gen = 0;

  readonly stats: FaultStats = {
    framesDropped: 0,
    acksDropped: 0,
    duplicated: 0,
    connectionsLost: 0,
  };

  constructor(opts: {
    clock: VirtualClock;
    rng: () => number;
    server: FakeServer;
    faults?: FaultProfile;
  }) {
    this.#clock = opts.clock;
    this.#rng = opts.rng;
    this.#server = opts.server;
    this.#faults = opts.faults ?? CLEAN;
  }

  get online(): boolean {
    return this.#online;
  }

  setOnline(value: boolean): void {
    if (value === this.#online) return;
    this.#online = value;
    this.#gen++;
  }

  #latency(): number {
    return this.#faults.latencyMs + Math.floor(this.#rng() * (this.#faults.jitterMs + 1));
  }

  send(frame: Frame, onAck: (ack: Ack) => void, onError: (reason: string) => void): void {
    if (!this.#online) {
      this.#clock.setTimeout(() => onError("offline"), 0);
      return;
    }

    const gen = this.#gen;
    const outbound = this.#latency();
    const frameRoll = this.#rng();
    const dupRoll = this.#rng();
    const ackRoll = this.#rng();

    this.#clock.setTimeout(() => {
      // The socket died somewhere between send() and arrival.
      if (!this.#online || gen !== this.#gen) {
        this.stats.connectionsLost++;
        onError("connection lost");
        return;
      }
      // Black hole: the server never sees this frame, and never will. Only the
      // client's own ack timeout gets us out of here.
      if (frameRoll < this.#faults.dropFrame) {
        this.stats.framesDropped++;
        return;
      }

      const ack = this.#server.receive(frame);
      if (dupRoll < this.#faults.duplicate) {
        this.stats.duplicated++;
        this.#server.receive(frame);
      }

      this.#clock.setTimeout(() => {
        if (!this.#online || gen !== this.#gen) {
          this.stats.connectionsLost++;
          onError("connection lost");
          return;
        }
        // The server has it durably; the phone will never hear so. It retries,
        // and dedupe on the far side is what keeps that from duplicating.
        if (ackRoll < this.#faults.dropAck) {
          this.stats.acksDropped++;
          return;
        }
        onAck(ack);
      }, this.#latency());
    }, outbound);
  }
}
