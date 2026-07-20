/** A message id minted on the phone, before the server has ever seen the message. */
export type ClientId = string;

export type OutboxState = "pending" | "inflight" | "acked";

export interface OutboxRow {
  /** Local monotonic enqueue order. The flush order, and the order the server must observe. */
  seq: number;
  clientId: ClientId;
  body: string;
  state: OutboxState;
  attempts: number;
  enqueuedAt: number;
  /** Authoritative id, known only after the server acks. Null until reconciled. */
  serverId: string | null;
}

export interface Frame {
  clientId: ClientId;
  body: string;
  attempt: number;
}

export interface Ack {
  clientId: ClientId;
  serverId: string;
  serverSeq: number;
}

export type TraceKind =
  | "connected"
  | "disconnected"
  | "enqueued"
  | "sent"
  | "ack"
  | "send-failed"
  | "retry-scheduled"
  | "flushing"
  | "settled";

export interface TraceEvent {
  /** Milliseconds on the virtual clock. */
  t: number;
  kind: TraceKind;
  text: string;
  clientId?: ClientId;
  /** Messages still unacked on the phone at this instant. */
  queued: number;
}

export interface Transport {
  send(frame: Frame, onAck: (ack: Ack) => void, onError: (reason: string) => void): void;
}
