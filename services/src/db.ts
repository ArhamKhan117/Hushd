/**
 * Postgres for the services: indexed chain events, the indexer's cursor, sealed RFQs
 * and quotes waiting for the enclave, match results and the per-deal mailbox.
 * Everything sealed is stored as the ciphertext it arrived as; the services never
 * hold a key that opens it.
 */
import pg from "pg";

export const SCHEMA = `
create table if not exists cursor (name text primary key, height bigint not null);
create table if not exists events (
  receipt_id text not null, log_index int not null, block_height bigint not null, block_ms bigint not null,
  contract text not null, event text not null, data jsonb not null, tx_hash text,
  primary key (receipt_id, log_index));
create index if not exists events_by_contract on events (contract, event, block_height);
create table if not exists rfqs (
  rfq_id bigint primary key, rfq_box text not null, commitment text not null, maker_boxes jsonb not null,
  closes_at_ms bigint not null, status text not null default 'open', created_ms bigint not null);
create table if not exists quotes (rfq_id bigint not null, maker text not null, box text not null, at_ms bigint not null, primary key (rfq_id, maker));
create table if not exists results (rfq_id bigint primary key, deal_id bigint, result jsonb not null, tx_hash text, at_ms bigint not null);
create table if not exists messages (id bigserial primary key, deal_id bigint not null, recipient text not null, box text not null, at_ms bigint not null);
create index if not exists messages_by_deal on messages (deal_id, recipient, id);
`;

export class Db {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
  }
  async migrate() {
    await this.pool.query(SCHEMA);
  }
  q<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, args: unknown[] = []) {
    return this.pool.query<T>(sql, args);
  }
  async close() {
    await this.pool.end();
  }

  async getCursor(name: string): Promise<number | null> {
    const r = await this.q<{ height: string }>("select height from cursor where name = $1", [name]);
    return r.rows[0] ? Number(r.rows[0].height) : null;
  }
  async setCursor(name: string, height: number) {
    await this.q("insert into cursor (name, height) values ($1, $2) on conflict (name) do update set height = excluded.height", [name, height]);
  }
}
