// @effect-diagnostics nodeBuiltinImport:off
// Incremental hashes retain framing state rather than complete source or mapped units.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  AUXILIARY_SCHEMAS,
  encodeJson,
  readRecord,
  transformRecord,
  isObject,
} from "./t3ImportFieldMap.ts";
import {
  assetReferences,
  contentDigests,
  isDerivedDigestColumn,
  mapUnit,
  reownAssets,
  TABLE_KEYS,
  EVENT_TYPES,
  type MaterializedUnit,
  type StoredRow,
  type SourceRecord,
  type MemberSummary,
} from "./t3ImportRecords.ts";
import {
  SOURCE_TABLES,
  forEachSourcePage,
  sourceTableName,
  type SourceTable,
} from "./t3ImportPaging.ts";
import {
  ImportLimits,
  assertLimit,
  digest,
  destinationId,
  RECORD_TABLES,
  PROJECTION_PREFIX,
  quoteIdentifier,
  rowBytesSql,
  type UnitKey,
} from "./t3ImportPlan.ts";
import type { StagedAsset } from "./t3ImportAssets.ts";

const decodePosition = Schema.decodeUnknownEffect(AUXILIARY_SCHEMAS.positions);
const decodeContext = Schema.decodeUnknownEffect(AUXILIARY_SCHEMAS.contexts);

export function emptyUnit(rootId: string, memberIds: ReadonlyArray<string> = []): MaterializedUnit {
  return {
    rootId,
    memberIds,
    records: Object.fromEntries(
      RECORD_TABLES.map((table) => [table, []]),
    ) as unknown as MaterializedUnit["records"],
    positions: [],
    contexts: [],
    raw: new Map(),
  };
}
const decode = (table: (typeof RECORD_TABLES)[number], row: StoredRow): SourceRecord => {
  const value = readRecord(table, String(row.payload_json));
  if (
    value.id !== row[TABLE_KEYS[table]] ||
    (value.threadId !== undefined && value.threadId !== row.thread_id)
  )
    throw new C.T3ImportError({ reason: "unreadable-records", stage: `${table}.identity` });
  return { row, value };
};

export const sourceSummary = Effect.fn("T3Import.sourceSummary")(function* (
  sql: SqlClient.SqlClient,
  members: ReadonlyArray<string>,
) {
  const limits = yield* ImportLimits;
  const counts: Record<string, number> = {};
  const ids = encodeJson(members);
  let count = 0,
    bytes = 0;
  for (const table of SOURCE_TABLES) {
    const name = sourceTableName(table);
    const columns = yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_table_xinfo(${name}) WHERE hidden = 0`;
    const rowBytes = rowBytesSql(columns.map((column) => column.name));
    const where =
      table === "context_transfers"
        ? "source_thread_id IN (SELECT value FROM json_each(?)) OR target_thread_id IN (SELECT value FROM json_each(?))"
        : "thread_id IN (SELECT value FROM json_each(?))";
    const rows = yield* sql.unsafe<{ count: number; bytes: number; maximum: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(${rowBytes}),0) AS bytes, COALESCE(MAX(${rowBytes}),0) AS maximum FROM ${quoteIdentifier(name)} WHERE ${where}`,
      table === "context_transfers" ? [ids, ids] : [ids],
    );
    counts[name] = rows[0]!.count;
    count += rows[0]!.count;
    bytes += rows[0]!.bytes;
    assertLimit("rows", count, limits);
    assertLimit("unitBytes", bytes, limits);
    assertLimit("rowBytes", rows[0]!.maximum, limits);
  }
  const oversized =
    yield* sql`SELECT 1 FROM t3_import_oversized WHERE thread_id IN (SELECT value FROM json_each(${ids})) OR thread_id IS NULL LIMIT 1`;
  if (oversized.length)
    return yield* new C.T3ImportError({ reason: "too-large", stage: "rowBytes" });
  const summaries = new Map<string, MemberSummary>();
  for (const thread of members) {
    const latest = yield* sql<
      NonNullable<MemberSummary["latest"]>["value"]
    >`SELECT run_id AS id,status,json_extract(payload_json,'$.rootNodeId') AS rootNodeId,completed_at AS completedAt FROM orchestration_v2_projection_runs WHERE thread_id = ${thread} AND status != 'queued' AND NOT (status = 'cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL) ORDER BY COALESCE(completed_at,'9999') DESC, ordinal DESC, run_id LIMIT 1`;
    const notice = yield* sql<
      NonNullable<MemberSummary["noticeRun"]>["value"]
    >`SELECT run_id AS id,ordinal,json_extract(payload_json,'$.rootNodeId') AS rootNodeId FROM orchestration_v2_projection_runs WHERE thread_id = ${thread} AND status != 'rolled_back' ORDER BY ordinal DESC, run_id LIMIT 1`;
    const last = yield* sql<{
      ordinal: number;
    }>`SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ${thread}`;
    const failure =
      latest[0]?.status === "failed"
        ? yield* sql<{
            class: string | null;
            resetAt: string | null;
          }>`SELECT json_extract(payload_json,'$.failure.class') AS class,json_extract(payload_json,'$.failure.resetAt') AS resetAt FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread} AND run_id = ${latest[0].id} AND node_id IS ${latest[0].rootNodeId} AND type = 'error' AND status = 'failed' ORDER BY updated_at DESC, ordinal DESC, turn_item_id LIMIT 1`
        : [];
    const max = yield* sql<{ ordinal: number }>`SELECT MAX(value) AS ordinal FROM (
      SELECT COALESCE(MAX(ordinal),0) AS value FROM orchestration_v2_turn_item_positions WHERE thread_id = ${thread}
      UNION ALL SELECT COALESCE(MAX(ordinal),0) FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread} AND run_id IS ${notice[0]?.id ?? null}
    )`;
    summaries.set(thread, {
      ...(latest[0] ? { latest: { value: latest[0] } } : {}),
      ...(notice[0] ? { noticeRun: { value: notice[0] } } : {}),
      failure: failure[0] ?? null,
      noticeOrdinal: Math.max(Number(notice[0]?.ordinal ?? 0) * 1_000_000, max[0]!.ordinal) + 1,
      lastRunOrdinal: last[0]!.ordinal,
    });
  }
  return { counts, summaries, sourceRows: count, sourceBytes: bytes };
});

export const streamDigests = Effect.fn("T3Import.streamDigests")(function* <E, R>(
  sql: SqlClient.SqlClient,
  root: string,
  members: ReadonlyArray<string>,
  stage: (refs: ReturnType<typeof assetReferences>) => Effect.Effect<void, E, R>,
  assets: ReadonlyMap<string, { ref: { owner: string }; asset: StagedAsset }>,
  inspect?: (table: SourceTable, row: StoredRow) => Effect.Effect<void, C.T3ImportError>,
) {
  const hashes = new Map(members.map((id) => [id, NodeCrypto.createHash("sha256")]));
  const part = (hash: NodeCrypto.Hash, value: string | Uint8Array) => {
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
  };
  for (const table of SOURCE_TABLES) {
    for (const hash of hashes.values()) part(hash, table);
    yield* forEachSourcePage(sql, members, table, (rows) =>
      Effect.gen(function* () {
        for (const row of rows) {
          const owners =
            table === "context_transfers"
              ? new Set([String(row.source_thread_id), String(row.target_thread_id)])
              : new Set([String(row.thread_id)]);
          for (const owner of owners) {
            const hash = hashes.get(owner);
            if (!hash) continue;
            for (const [column, value] of Object.entries(row).sort(([a], [b]) =>
              a.localeCompare(b),
            )) {
              if (isDerivedDigestColumn(table, column)) continue;
              part(hash, column);
              part(hash, value instanceof Uint8Array ? "blob" : typeof value);
              part(hash, value instanceof Uint8Array ? value : encodeJson(value));
            }
          }
          if (table === "positions" || table === "contexts") {
            const checked =
              table === "positions"
                ? Effect.asVoid(decodePosition(row))
                : Effect.asVoid(decodeContext(row));
            yield* checked.pipe(
              Effect.mapError(
                (cause) =>
                  new C.T3ImportError({
                    reason: "unreadable-records",
                    stage: "auxiliary-row",
                    cause,
                  }),
              ),
            );
          }
          if (inspect) yield* inspect(table, row);
          if (table === "messages" || table === "turn_items") {
            const unit = emptyUnit(root);
            yield* stage(
              assetReferences({
                ...unit,
                records: { ...unit.records, [table]: [decode(table, row)] },
              }),
            );
          }
          yield* Effect.yieldNow;
        }
      }),
    );
  }
  for (const [key, { ref, asset }] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    const hash = hashes.get(ref.owner);
    if (hash)
      part(
        hash,
        encodeJson([
          key,
          asset.sourceAssetId,
          asset.kind,
          asset.selectedRelativeName,
          asset.actualExtension,
          asset.sha256,
          asset.bytes,
          asset.reason ?? null,
          asset.sidecar?.sha256 ?? null,
          asset.sidecar?.bytes ?? 0,
        ]),
      );
  }
  const threadDigests = new Map([...hashes].map(([id, hash]) => [id, hash.digest("hex")]));
  return {
    threadDigests,
    digest: digest(
      encodeJson([
        threadDigests.get(root),
        ...[...threadDigests].filter(([id]) => id !== root).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  } satisfies ReturnType<typeof contentDigests>;
});

export const pageOwners = Effect.fn("T3Import.pageOwners")(function* (
  sql: SqlClient.SqlClient,
  unit: MaterializedUnit,
) {
  const refs = new Set<string>();
  const own = new Map<string, string>();
  for (const table of RECORD_TABLES)
    for (const { row, value } of unit.records[table]) {
      if (table !== "context_transfers") {
        refs.add(String(value.id));
        own.set(String(value.id), String(row.thread_id));
      }
      transformRecord(table, value, (id, classification) => {
        if (classification !== "placeholder") refs.add(id);
        return id;
      });
    }
  for (const row of unit.contexts) refs.add(String(row.item_id));
  const owners = new Map<string, string>();
  let batch: string[] = [],
    bytes = 0;
  const lookup = Effect.fn("T3Import.lookupOwners")(function* () {
    if (!batch.length) return;
    const query = RECORD_TABLES.filter((table) => table !== "context_transfers")
      .map(
        (table) =>
          `SELECT ${quoteIdentifier(TABLE_KEYS[table])} AS id, thread_id FROM ${quoteIdentifier(PROJECTION_PREFIX + table)} WHERE ${quoteIdentifier(TABLE_KEYS[table])} IN (SELECT value FROM json_each(?))`,
      )
      .join(" UNION ALL ");
    const encoded = encodeJson(batch);
    const rows = yield* sql.unsafe<{ id: string; thread_id: string }>(
      query,
      RECORD_TABLES.filter((t) => t !== "context_transfers").map(() => encoded),
    );
    for (const row of rows) {
      const prior = owners.get(row.id) ?? own.get(row.id);
      if (prior !== undefined && prior !== row.thread_id)
        return yield* new C.T3ImportError({
          reason: "unreadable-records",
          stage: "ambiguous-reference-owner",
        });
      owners.set(row.id, row.thread_id);
    }
    batch = [];
    bytes = 0;
  });
  for (const id of refs) {
    const size = Buffer.byteLength(encodeJson(id));
    if (batch.length && (batch.length === 500 || bytes + size > 64 * 1024)) yield* lookup();
    batch.push(id);
    bytes += size;
    if (bytes >= 64 * 1024) yield* lookup();
  }
  yield* lookup();
  return owners;
});

const decodePage = (root: string, table: SourceTable, rows: ReadonlyArray<StoredRow>) => {
  const unit = emptyUnit(root);
  if (table === "positions" || table === "contexts") return { ...unit, [table]: rows };
  return { ...unit, records: { ...unit.records, [table]: rows.map((row) => decode(table, row)) } };
};
export type MapInput = Parameters<typeof mapUnit>[0];
export type MappedPage = ReturnType<typeof mapUnit>;

const resolvePageReferences = Effect.fn("T3Import.resolvePageReferences")(function* (
  source: SqlClient.SqlClient,
  destination: SqlClient.SqlClient,
  environment: string,
  owners: ReadonlyMap<string, string>,
  keys: ReadonlyMap<string, UnitKey>,
) {
  const informationalKeys = new Map<string, UnitKey>();
  for (const owner of new Set(owners.values())) {
    if (keys.has(owner)) continue;
    let root = owner;
    const seen = new Set<string>();
    while (!seen.has(root) && seen.size <= 12) {
      seen.add(root);
      const rows = yield* source<{
        parent: string | null;
        attached: number;
      }>`SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent, json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' OR json_extract(payload_json, '$.lineage.sideChat') = 1 AS attached FROM orchestration_v2_projection_threads WHERE thread_id = ${root}`;
      if (!rows[0]?.attached || typeof rows[0].parent !== "string") break;
      root = rows[0].parent;
    }
    const copies = yield* destination<{
      generation: number;
    }>`SELECT json_extract(payload_json, '$.importedFrom.generation') AS generation FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json, '$.importedFrom.environmentId') = ${environment} AND json_extract(payload_json, '$.importedFrom.threadId') = ${owner} ORDER BY generation DESC LIMIT 1`;
    informationalKeys.set(owner, [
      environment,
      root,
      Number.isSafeInteger(copies[0]?.generation) && copies[0]!.generation > 0
        ? copies[0]!.generation
        : 1,
    ]);
  }
  const resolvedPlanRefs = new Set<string>();
  for (const [id, owner] of owners) {
    const key = informationalKeys.get(owner);
    if (!key) continue;
    const rows =
      yield* destination`SELECT 1 FROM orchestration_v2_projection_plans plan JOIN orchestration_v2_projection_threads thread ON thread.thread_id = plan.thread_id WHERE plan.plan_id = ${destinationId(id, key)} AND plan.thread_id = ${destinationId(owner, key)} AND thread.deleted_at IS NULL LIMIT 1`;
    if (rows.length) resolvedPlanRefs.add(id);
  }
  return { informationalKeys, resolvedPlanRefs };
});

const eventTable = new Map<string, string>(
  RECORD_TABLES.map((table) => [EVENT_TYPES[table], PROJECTION_PREFIX + table]),
);
export const streamMapped = Effect.fn("T3Import.streamMapped")(function* <E, R>(
  source: SqlClient.SqlClient,
  destination: SqlClient.SqlClient,
  input: Omit<MapInput, "unit" | "owners" | "informationalKeys" | "resolvedPlanRefs"> & {
    root: string;
    members: ReadonlyArray<string>;
    checkCancelled?: Effect.Effect<void, C.T3ImportError>;
  },
  consume: (page: MappedPage) => Effect.Effect<void, E, R>,
) {
  const limits = yield* ImportLimits;
  const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(C.OrchestrationV2DomainEventJson));
  const expectedHashes = new Map(
    SOURCE_TABLES.map((table) => [sourceTableName(table), NodeCrypto.createHash("sha256")]),
  );
  const encodedBytesByTable: Record<string, number> = Object.fromEntries(
    SOURCE_TABLES.map((table) => [sourceTableName(table), 0]),
  );
  const counts: Record<string, number> = Object.fromEntries(
    SOURCE_TABLES.map((table) => [sourceTableName(table), 0]),
  );
  const links = new Map<string, MappedPage["informationalLinks"][number]>();
  let exclusions = 0,
    unavailableLinks = 0,
    mappedBytes = 0;
  const mappedAssets = reownAssets(input.assets, input.key);
  const mapping = { ...input, mappedAssets, includeAssets: false };
  let pending: MappedPage[] = [];
  let pendingRows = 0,
    pendingBytes = 0;
  const flush = Effect.fn("T3Import.flushMappedPage")(function* () {
    if (!pending.length) return;
    const expected = new Map<string, string[][]>();
    for (const page of pending)
      for (const [name, keys] of page.expected) {
        const current = expected.get(name) ?? [];
        current.push(...keys);
        expected.set(name, current);
      }
    const page = {
      events: pending.flatMap((page) => page.events),
      positions: pending.flatMap((page) => page.positions),
      contexts: pending.flatMap((page) => page.contexts),
      expected,
      assets: [],
      exclusions: 0,
      unavailableLinks: 0,
      informationalLinks: [],
    };
    yield* consume(page);
    pending = [];
    pendingRows = 0;
    pendingBytes = 0;
  });
  const account = Effect.fn("T3Import.accountMappedPage")(function* (page: MappedPage) {
    for (const [table, keys] of page.expected)
      for (const key of keys) {
        expectedHashes.get(table)!.update(encodeJson(key));
        counts[table] = (counts[table] ?? 0) + 1;
      }
    let pageBytes = 0;
    for (const event of page.events) {
      const encoded = yield* encodeEvent(event);
      const bytes = Buffer.byteLength(encoded);
      assertLimit("rowBytes", bytes, limits);
      mappedBytes += bytes;
      const table = eventTable.get(event.type)!;
      encodedBytesByTable[table] = (encodedBytesByTable[table] ?? 0) + bytes;
      pageBytes += bytes;
    }
    assertLimit("unitBytes", mappedBytes, limits);
    exclusions += page.exclusions;
    unavailableLinks += page.unavailableLinks;
    for (const link of page.informationalLinks) {
      const id = encodeJson([link.sourceOwner, link.destinationThreadId]);
      const prior = links.get(id);
      links.set(id, prior ? { ...prior, count: prior.count + link.count } : link);
      if (links.size > limits.informationalLinks)
        return yield* new C.T3ImportError({
          reason: "too-large",
          stage: "informational-links",
          maximum: limits.informationalLinks,
          actual: links.size,
        });
    }
    for (const [name, rows] of [
      ["orchestration_v2_turn_item_positions", page.positions],
      ["mcp_app_model_context", page.contexts],
    ] as const)
      for (const row of rows)
        encodedBytesByTable[name] =
          (encodedBytesByTable[name] ?? 0) + Buffer.byteLength(encodeJson(row));
    pageBytes +=
      Buffer.byteLength(encodeJson(page.positions)) + Buffer.byteLength(encodeJson(page.contexts));
    const rows = page.events.length + page.positions.length + page.contexts.length;
    if (pending.length && (pendingRows + rows > 256 || pendingBytes + pageBytes > 4 * 1024 ** 2))
      yield* flush();
    pending.push(page);
    pendingRows += rows;
    pendingBytes += pageBytes;
    if (pendingRows >= 256 || pendingBytes >= 4 * 1024 ** 2) yield* flush();
  });
  const notices = mapUnit({
    ...mapping,
    includeAssets: true,
    unit: emptyUnit(input.root, input.members),
    owners: new Map(),
    notices: true,
    limits,
  });
  for (const table of [
    "threads",
    "positions",
    ...RECORD_TABLES.filter((table) => table !== "threads"),
    "contexts",
  ] as const) {
    yield* forEachSourcePage(source, input.members, table, (rows) =>
      Effect.gen(function* () {
        const pageUnit = decodePage(input.root, table, rows);
        const owners = yield* pageOwners(source, pageUnit);
        const resolved = yield* resolvePageReferences(
          source,
          destination,
          input.key[0],
          owners,
          input.keys,
        );
        const units =
          table === "positions" || table === "contexts"
            ? rows.map((row) => decodePage(input.root, table, [row]))
            : pageUnit.records[table].map((record) => {
                const empty = emptyUnit(input.root);
                return { ...empty, records: { ...empty.records, [table]: [record] } };
              });
        for (const unit of units) {
          if (input.checkCancelled) yield* input.checkCancelled;
          for (const record of Object.values(unit.records).flat()) {
            const value = record.value;
            if (
              (table === "runs" &&
                (!["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  String(value.status),
                ) ||
                  (isObject(value.delegatedCompletion) &&
                    value.delegatedCompletion.delivery != null))) ||
              (table === "runtime_requests" && value.status === "pending") ||
              (table === "subagents" &&
                ["idle", "pending", "running", "waiting"].includes(String(value.status))) ||
              (table === "context_transfers" && value.status === "pending" && value.type !== "fork")
            )
              return yield* new C.T3ImportError({ reason: "pending-work", stage: table });
            if (table === "turn_items") {
              const pending = ["idle", "pending", "running", "waiting"].includes(
                String(value.status),
              );
              const request = ["approval_request", "user_input_request"].includes(
                String(value.type),
              )
                ? yield* source<{
                    status: string;
                  }>`SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ${String(value.requestId)}`
                : [];
              if (
                (value.type === "link_request" && (value.linkStatus === "pending" || pending)) ||
                (value.type === "secret_request" &&
                  (value.secretStatus === "pending" || pending)) ||
                (["approval_request", "user_input_request"].includes(String(value.type)) &&
                  (pending || !request[0] || request[0].status === "pending"))
              )
                return yield* new C.T3ImportError({
                  reason: "pending-work",
                  stage: String(value.type),
                });
            }
          }
          yield* account(
            mapUnit({ ...mapping, ...resolved, unit, owners, notices: false, limits }),
          );
          yield* Effect.yieldNow;
        }
      }),
    );
    const noticeRows =
      table === "positions"
        ? notices.positions
        : table === "context_transfers"
          ? notices.events
          : [];
    for (let offset = 0; offset < noticeRows.length; offset += 128) {
      const end = offset + 128;
      const positions = table === "positions" ? notices.positions.slice(offset, end) : [];
      const events = table === "context_transfers" ? notices.events.slice(offset, end) : [];
      const expected = new Map(
        [...notices.expected].map(([name, keys]) => [
          name,
          (table === "positions" && name === "orchestration_v2_turn_item_positions") ||
          (table === "context_transfers" && name === PROJECTION_PREFIX + "turn_items")
            ? keys.slice(offset, end)
            : [],
        ]),
      );
      yield* account({
        ...notices,
        positions,
        events,
        contexts: [],
        expected,
        exclusions: 0,
        informationalLinks: [],
        unavailableLinks: 0,
      });
    }
    yield* flush();
  }
  assertLimit(
    "rows",
    Object.values(counts).reduce((a, b) => a + b, 0),
    limits,
  );
  return {
    expectedKeysDigest: digest(
      encodeJson([...expectedHashes].map(([name, hash]) => [name, hash.digest("hex")])),
    ),
    counts,
    mappedBytes,
    encodedBytesByTable,
    exclusions,
    unavailableLinks,
    informationalLinks: [...links.values()],
    assets: notices.assets,
  };
});
