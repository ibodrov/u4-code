import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { encodeJson } from "./t3ImportFieldMap.ts";
import {
  PROJECTION_PREFIX,
  RECORD_TABLES,
  quoteIdentifier,
  rowBytesSql,
  assertLimit,
  ImportLimits,
  ImportPageLimits,
} from "./t3ImportPlan.ts";
import { TABLE_KEYS, type StoredRow } from "./t3ImportRecords.ts";

export const SOURCE_TABLES = [...RECORD_TABLES, "positions", "contexts"] as const;
export type SourceTable = (typeof SOURCE_TABLES)[number];
export const sourceTableName = (table: SourceTable) =>
  table === "positions"
    ? "orchestration_v2_turn_item_positions"
    : table === "contexts"
      ? "mcp_app_model_context"
      : PROJECTION_PREFIX + table;
export const sourceKeyColumns = (table: SourceTable) =>
  table === "positions"
    ? ["thread_id", "turn_item_id"]
    : table === "contexts"
      ? ["thread_id", "item_id"]
      : [TABLE_KEYS[table]];
// Each invocation releases its page before the next SQLite reply is materialized.
export const forEachSourcePage = Effect.fn("T3Import.forEachSourcePage")(function* <E, R>(
  sql: SqlClient.SqlClient,
  members: ReadonlyArray<string>,
  table: SourceTable,
  consume: (rows: ReadonlyArray<StoredRow>) => Effect.Effect<void, E, R>,
  metadataOnly = false,
) {
  const limits = yield* ImportLimits;
  const pages = yield* ImportPageLimits;
  const name = quoteIdentifier(sourceTableName(table));
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_xinfo(${sourceTableName(table)}) WHERE hidden = 0 ORDER BY cid`;
  const rowBytes = rowBytesSql(columns.map((column) => column.name));
  const keys = sourceKeyColumns(table);
  const order = keys.map(quoteIdentifier).join(", ");
  const keyBytes = rowBytesSql(keys);
  const ids = encodeJson(members);
  const where =
    table === "context_transfers"
      ? "(source_thread_id IN (SELECT value FROM json_each(?)) OR target_thread_id IN (SELECT value FROM json_each(?)))"
      : "thread_id IN (SELECT value FROM json_each(?))";
  const bindings = table === "context_transfers" ? [ids, ids] : [ids];
  let cursor: ReadonlyArray<string> | undefined;
  for (;;) {
    const after = cursor ? ` AND (${order}) > (${keys.map(() => "?").join(", ")})` : "";
    const metadata = yield* sql.unsafe<StoredRow & { __bytes: number }>(
      `SELECT ${order}, __bytes FROM (
        SELECT *, SUM(__key_bytes) OVER (ORDER BY ${order}) AS __cumulative, ROW_NUMBER() OVER (ORDER BY ${order}) AS __rn
        FROM (SELECT ${order}, ${rowBytes} AS __bytes, ${keyBytes} AS __key_bytes FROM ${name} WHERE ${where}${after} ORDER BY ${order} LIMIT ${pages.metadataRows})
      ) WHERE __cumulative <= ${pages.metadataBytes} OR __rn = 1 ORDER BY ${order}`,
      [...bindings, ...(cursor ?? [])],
    );
    if (metadata.length === 0) return;
    if (metadata.some((row) => keys.some((key) => typeof row[key] !== "string")))
      return yield* new C.T3ImportError({
        reason: "unreadable-records",
        stage: `${table}.identity`,
      });
    if (metadataOnly) {
      yield* consume(metadata);
      const last = metadata[metadata.length - 1]!;
      cursor = keys.map((key) => String(last[key]));
      yield* Effect.yieldNow;
      continue;
    }
    let offset = 0;
    while (offset < metadata.length) {
      let end = offset,
        bytes = 0;
      while (end < metadata.length && end - offset < pages.payloadRows) {
        const next = metadata[end]!.__bytes;
        assertLimit("rowBytes", next, limits);
        if (end > offset && bytes + next > pages.payloadBytes) break;
        bytes += next;
        end++;
        if (bytes >= pages.payloadBytes) break;
      }
      const batch = metadata.slice(offset, end).map((row) => keys.map((key) => row[key]));
      const rows = yield* sql.unsafe<StoredRow>(
        `SELECT source.* FROM ${name} source JOIN json_each(?) expected ON ${keys.map((key, index) => `source.${quoteIdentifier(key)} = json_extract(expected.value, '$[${index}]')`).join(" AND ")} ORDER BY ${keys.map((key) => `source.${quoteIdentifier(key)}`).join(", ")}`,
        [encodeJson(batch)],
      );
      if (rows.length !== batch.length)
        return yield* new C.T3ImportError({
          reason: "unreadable-records",
          stage: `${table}.identity`,
        });
      yield* consume(rows);
      offset = end;
      yield* Effect.yieldNow;
    }
    const last = metadata[metadata.length - 1]!;
    cursor = keys.map((key) => String(last[key]));
  }
});
