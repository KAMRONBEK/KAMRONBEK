import { randomUUID } from "node:crypto";

import type { VirtualClock } from "./clock.ts";
import type { Outbox } from "./outbox.ts";
import type { Ack, ClientId, TraceEvent, TraceKind, Transport } from "./types.ts";

export interface QueueOptions {
  outbox: Outbox;
  transport: Transport;
  clock: VirtualClock;
  rng: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** First-attempt wait for an ack. Doubles per attempt, up to maxAckTimeoutMs. */
  ackTimeoutMs?: number;
  maxAckTimeoutMs?: number;
  /**
   * Mints the id the phone assigns before the server has seen the message.
   * Defaults to a UUID; the simulator injects a seeded generator so runs stay
   * reproducible. It must be unique across process restarts — the outbox holds
   * acked rows forever and client_id is UNIQUE.
   */
  mintId?: () => ClientId;
  onEvent?: (event: TraceEvent) => void;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * An offline-first outbox.
 *
 * The three properties it holds, and why each is a design choice rather than an
 * accident of timing:
 *
 *   no loss       every message is in SQLite before the network is touched
 *   order         exactly one frame in flight, always taken from the head
 *   no duplicates client ids are minted on the phone and deduped by the server,
 *                 so retrying after a lost ack is safe by construction
 *
 * Note what it does NOT do: gate sending on a connectivity flag. On a phone that
 * flag lies — captive portals, wifi associated with no route, a socket that is
 * open but black-holing. The transport's own failure is the only signal worth
 * trusting, so the queue always attempts and backs off. A connectivity event is
 * taken as a hint to retry sooner (see onConnectivityChange, which discards the
 * accrued backoff), never as permission to try at all.
 */
export class OutboxQueue {
  #outbox: Outbox;
  #transport: Transport;
  #clock: VirtualClock;
  #rng: () => number;
  #baseDelayMs: number;
  #maxDelayMs: number;
  #ackTimeoutMs: number;
  #maxAckTimeoutMs: number;
  #mintId: () => ClientId;
  #onEvent: (event: TraceEvent) => void;

  #inflight: ClientId | null = null;
  #retryTimer: number | null = null;
  #ackTimer: number | null = null;
  /** Invalidates callbacks from an attempt we have already given up on. */
  #token = 0;
  #settled = true;
  #everConnected = false;

  constructor(opts: QueueOptions) {
    this.#outbox = opts.outbox;
    this.#transport = opts.transport;
    this.#clock = opts.clock;
    this.#rng = opts.rng;
    this.#baseDelayMs = opts.baseDelayMs ?? 1000;
    this.#maxDelayMs = opts.maxDelayMs ?? 30000;
    this.#ackTimeoutMs = opts.ackTimeoutMs ?? 2000;
    this.#maxAckTimeoutMs = opts.maxAckTimeoutMs ?? 60000;
    this.#mintId = opts.mintId ?? (() => randomUUID());
    this.#onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Accepts a message whether or not there is a network. Returns immediately
   * with the optimistic id the UI renders against.
   */
  send(body: string): ClientId {
    const clientId = this.#mintId();
    this.#outbox.enqueue(clientId, body, this.#clock.now());
    this.#settled = false;
    this.#emit("enqueued", `queued "${body}"`, clientId);
    this.#pump();
    return clientId;
  }

  /**
   * A hint from the OS that the link changed. Coming up, it collapses the
   * backoff we accumulated against the old connection and flushes now.
   */
  onConnectivityChange(up: boolean): void {
    if (!up) {
      this.#emit("disconnected", "CONNECTION LOST");
      return;
    }

    // A fresh link is new information. Without discarding the backoff accrued
    // against the dead one, a phone leaving a tunnel sits idle for whatever the
    // last delay was — up to maxDelayMs — with a live radio and a full outbox.
    const head = this.#outbox.head();
    if (head) this.#outbox.resetAttempts(head.clientId);
    this.#clearRetry();

    this.#emit("connected", this.#everConnected ? "reconnected" : "connected");
    this.#everConnected = true;

    const queued = this.#outbox.queuedCount();
    if (queued > 0) this.#emit("flushing", `flushing ${queued} queued`);
    this.#pump();
  }

  /** The authoritative id for an optimistic one, once reconciled. */
  serverIdFor(clientId: ClientId): string | null {
    return this.#outbox.serverIdFor(clientId);
  }

  #pump(): void {
    if (this.#inflight !== null || this.#retryTimer !== null) return;

    const row = this.#outbox.head();
    if (!row) {
      if (!this.#settled) {
        this.#settled = true;
        this.#emit("settled", "queue drained, in order");
      }
      return;
    }

    const attempt = this.#outbox.bumpAttempts(row.clientId);
    this.#outbox.markInflight(row.clientId);
    this.#inflight = row.clientId;
    const token = ++this.#token;

    this.#emit(
      "sent",
      attempt === 1 ? `send "${row.body}"` : `resend "${row.body}" (attempt ${attempt})`,
      row.clientId,
    );

    // The ack timeout has to grow with the retries. Held at a constant, a link
    // that is merely slow — congested cellular, RTT above the timeout — times
    // out every ack it is still waiting for, invalidates it, and resends
    // forever: the head never clears and nothing behind it moves.
    const ackTimeout = Math.min(this.#maxAckTimeoutMs, this.#ackTimeoutMs * 2 ** (attempt - 1));

    this.#ackTimer = this.#clock.setTimeout(() => {
      if (token !== this.#token) return;
      this.#fail(row.clientId, "no ack");
    }, ackTimeout);

    this.#transport.send(
      { clientId: row.clientId, body: row.body, attempt },
      (ack) => {
        if (token !== this.#token) return;
        this.#onAck(ack);
      },
      (reason) => {
        if (token !== this.#token) return;
        this.#fail(row.clientId, reason);
      },
    );
  }

  #onAck(ack: Ack): void {
    this.#clearAck();
    this.#token++;
    this.#inflight = null;
    this.#outbox.markAcked(ack.clientId, ack.serverId);
    this.#emit("ack", `delivered · ${ack.clientId} -> ${ack.serverId}`, ack.clientId);
    this.#pump();
  }

  #fail(clientId: ClientId, reason: string): void {
    this.#clearAck();
    this.#token++;
    this.#inflight = null;
    this.#outbox.markPending(clientId);
    this.#emit("send-failed", reason, clientId);

    const row = this.#outbox.head();
    const attempts = row ? Math.max(1, row.attempts) : 1;
    const ceiling = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempts - 1));
    // Equal jitter: half the ceiling plus a random half. Keeps the doubling
    // shape while stopping every client in a region retrying on the same tick.
    const delay = Math.round(ceiling / 2 + this.#rng() * (ceiling / 2));

    this.#emit("retry-scheduled", `retry in ${secs(delay)}`);
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      this.#pump();
    }, delay);
  }

  #clearAck(): void {
    if (this.#ackTimer !== null) {
      this.#clock.clearTimeout(this.#ackTimer);
      this.#ackTimer = null;
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) {
      this.#clock.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #emit(kind: TraceKind, text: string, clientId?: ClientId): void {
    this.#onEvent({
      t: this.#clock.now(),
      kind,
      text,
      clientId,
      queued: this.#outbox.queuedCount(),
    });
  }
}
