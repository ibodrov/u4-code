// @effect-diagnostics nodeBuiltinImport:off
// Descriptor anchoring, hard links and inode witnesses require Node filesystem primitives.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";

import { T3ImportError, type T3ImportPage, type T3ImportRow } from "@t3tools/contracts";

export const IMPORT_LIMITS = {
  snapshotBytes: 8 * 1024 ** 3,
  threads: 300,
  units: 100,
  rows: 80_000,
  unitBytes: 256 * 1024 ** 2,
  rowBytes: 16 * 1024 ** 2,
  assets: 512,
  unitAssetBytes: 512 * 1024 ** 2,
  jobAssetBytes: 4 * 1024 ** 3,
  ownershipBytes: 64 * 1024,
  informationalLinks: 20_000,
  depth: 12,
} as const;
export type ImportLimitValues = { readonly [K in keyof typeof IMPORT_LIMITS]: number };
export const ImportLimits = Context.Reference<ImportLimitValues>("t3/u4/t3Import/Limits", {
  defaultValue: () => IMPORT_LIMITS,
});
export const ImportPageLimits = Context.Reference<{
  readonly metadataRows: number;
  readonly metadataBytes: number;
  readonly payloadRows: number;
  readonly payloadBytes: number;
}>("t3/u4/t3Import/PageLimits", {
  defaultValue: () => ({
    metadataRows: 2000,
    metadataBytes: 1024 ** 2,
    payloadRows: 256,
    payloadBytes: 4 * 1024 ** 2,
  }),
});
export type UnitKey = readonly [environmentId: string, rootId: string, generation: number];
export const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export function destinationId(sourceId: string, key: UnitKey, kind = "record"): string {
  const prefix = sourceId.split(":")[0] ?? "";
  const bytes = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(["u4-t3-import/3", ...key, sourceId]))
    .digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let encoded = "",
    buffer = 0,
    bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
  }
  return `${/^[a-z][a-z0-9-]{0,31}$/.test(prefix) ? prefix : kind}:t3i:${encoded.slice(0, 26)}`;
}
export const isImportedRecordId = (value: string) =>
  /^[a-z][a-z0-9-]{0,31}:t3i:[a-z2-7]{26}$/.test(value);
export function assertLimit(
  name: keyof typeof IMPORT_LIMITS,
  actual: number,
  limits: ImportLimitValues = IMPORT_LIMITS,
) {
  const maximum = limits[name];
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum)
    throw new T3ImportError({
      reason: "too-large",
      stage: name,
      actual: Math.max(0, actual),
      maximum,
    });
}
export function pageRows(rows: ReadonlyArray<T3ImportRow>, cursor?: string): T3ImportPage {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new T3ImportError({ reason: "plan-changed", stage: "cursor" });
  return {
    rows: rows.slice(offset, offset + 100),
    nextCursor: offset + 100 < rows.length ? String(offset + 100) : null,
  };
}
export const PROJECTION_PREFIX = "orchestration_v2_projection_";
export const RECORD_TABLES = [
  "threads",
  "runs",
  "run_attempts",
  "nodes",
  "subagents",
  "provider_turns",
  "runtime_requests",
  "messages",
  "plans",
  "turn_items",
  "context_handoffs",
  "context_transfers",
] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];
export const SNAPSHOT_TABLES = [
  "projection_projects",
  ...RECORD_TABLES.map((table) => PROJECTION_PREFIX + table),
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_legacy_imports",
  "mcp_app_model_context",
  ...["provider_sessions", "provider_session_bindings", "provider_threads"].map(
    (table) => PROJECTION_PREFIX + table,
  ),
] as const;

// Names come exclusively from the trusted migrated schema, never from source DDL.
export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const valueBytesSql = (column: string) => {
  const c = quoteIdentifier(column);
  return `CASE typeof(${c}) WHEN 'null' THEN 0 WHEN 'integer' THEN 8 WHEN 'real' THEN 8 WHEN 'text' THEN length(CAST(${c} AS BLOB)) WHEN 'blob' THEN length(${c}) END`;
};
export const rowBytesSql = (columns: ReadonlyArray<string>) =>
  columns.map(valueBytesSql).join(" + ");
