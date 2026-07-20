import { DatabaseSync } from "node:sqlite";
import type { ClientId, OutboxRow } from "./types.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT    NOT NULL UNIQUE,
    body        TEXT    NOT NULL,
    state       TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    enqueued_at INTEGER NOT NULL,
    server_id   TEXT
  );
`;

function toRow(r: Record<string, unknown>): OutboxRow {
  return {
    seq: r.seq as number,
    clientId: r.client_id as ClientId,
    body: r.body as string,
    state: r.state as OutboxRow["state"],
    attempts: r.attempts as number,
    enqueuedAt: r.enqueued_at as number,
    serverId: (r.server_id as string | null) ?? null,
  };
}

/**
 * The outbox is the durability boundary. A message is "accepted" the instant it
 * lands here — before any network call — which is what lets `send()` succeed
 * with the radio off, and what lets an unacked message survive a process death.
 */
export class Outbox {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  /** `:memory:` for tests, a real path to prove restart survival. */
  static open(path = ":memory:"): Outbox {
    return new Outbox(new DatabaseSync(path));
  }

  enqueue(clientId: ClientId, body: string, at: number): number {
    const info = this.#db
      .prepare("INSERT INTO outbox (client_id, body, state, enqueued_at) VALUES (?, ?, 'pending', ?)")
      .run(clientId, body, at);
    return Number(info.lastInsertRowid);
  }

  /**
   * The oldest message the server has not acked. Sending strictly from the head,
   * one at a time, is what makes order a property of the design rather than a
   * hope about network timing.
   */
  head(): OutboxRow | null {
    const r = this.#db
      .prepare("SELECT * FROM outbox WHERE state != 'acked' ORDER BY seq LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return r ? toRow(r) : null;
  }

  markInflight(clientId: ClientId): void {
    this.#db.prepare("UPDATE outbox SET state = 'inflight' WHERE client_id = ?").run(clientId);
  }

  /**
   * An abandoned attempt returns the row to the pool. Note this is an in-process
   * guarantee: a crash while a row is 'inflight' leaves it that way on disk.
   * Nothing reads `state` to decide what to send — head() selects on
   * `!= 'acked'` — so recovery is correct regardless, but the column is
   * descriptive rather than authoritative across a restart.
   */
  markPending(clientId: ClientId): void {
    this.#db
      .prepare("UPDATE outbox SET state = 'pending' WHERE client_id = ? AND state = 'inflight'")
      .run(clientId);
  }

  /** Reconciliation: the optimistic row learns its authoritative server id. */
  markAcked(clientId: ClientId, serverId: string): void {
    this.#db
      .prepare("UPDATE outbox SET state = 'acked', server_id = ? WHERE client_id = ?")
      .run(serverId, clientId);
  }

  /** Returns the new attempt count for this message. */
  bumpAttempts(clientId: ClientId): number {
    this.#db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE client_id = ?").run(clientId);
    const r = this.#db
      .prepare("SELECT attempts FROM outbox WHERE client_id = ?")
      .get(clientId) as Record<string, unknown>;
    return r.attempts as number;
  }

  resetAttempts(clientId: ClientId): void {
    this.#db.prepare("UPDATE outbox SET attempts = 0 WHERE client_id = ?").run(clientId);
  }

  /** Unacked messages sitting on the phone. */
  queuedCount(): number {
    const r = this.#db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state != 'acked'")
      .get() as Record<string, unknown>;
    return r.n as number;
  }

  all(): OutboxRow[] {
    const rows = this.#db.prepare("SELECT * FROM outbox ORDER BY seq").all() as Record<string, unknown>[];
    return rows.map(toRow);
  }

  close(): void {
    this.#db.close();
  }

  serverIdFor(clientId: ClientId): string | null {
    const r = this.#db
      .prepare("SELECT server_id FROM outbox WHERE client_id = ?")
      .get(clientId) as Record<string, unknown> | undefined;
    return (r?.server_id as string | null) ?? null;
  }
}
