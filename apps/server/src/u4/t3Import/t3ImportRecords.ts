// @effect-diagnostics nodeBuiltinImport:off
// Content digests stream raw SQLite values without materializing a second serialization.
import * as NodeCrypto from "node:crypto";

import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  encodeJson,
  AUXILIARY_SCHEMAS,
  isObject,
  readRecord,
  transformRecord,
  type FieldClass,
} from "./t3ImportFieldMap.ts";
import {
  attachmentCandidatesById,
  attachmentRelativePath,
  createDeterministicAttachmentId,
} from "../../attachmentStore.ts";
import { toolAssetId, rewriteToolAsset, type StagedAsset } from "./t3ImportAssets.ts";
import {
  assertLimit as checkImportLimit,
  ImportLimits,
  IMPORT_LIMITS,
  type ImportLimitValues,
  destinationId,
  digest,
  PROJECTION_PREFIX,
  RECORD_TABLES,
  quoteIdentifier,
  rowBytesSql,
  type RecordTable,
  type UnitKey,
} from "./t3ImportPlan.ts";

const isImportError = Schema.is(C.T3ImportError);
const decodeAttachment = Schema.decodeUnknownSync(C.ChatAttachment);
const decodeRuntimeMode = Schema.decodeUnknownSync(C.RuntimeMode);
const decodeDomainEvent = Schema.decodeUnknownSync(C.OrchestrationV2DomainEventJson);
const encodeDomainEvent = Schema.encodeSync(
  Schema.fromJsonString(C.OrchestrationV2DomainEventJson),
);
// The inline output flag is derived from payload_json and did not exist before migration 95.
export function isDerivedDigestColumn(table: string, column: string): boolean {
  return table === "turn_items" && column === "inline_work_output";
}

export type StoredRow = Readonly<Record<string, string | number | null | Uint8Array>>;
export interface SourceRecord {
  readonly row: StoredRow;
  readonly value: Record<string, unknown>;
}
export interface SourceUnit {
  readonly rootId: string;
  readonly memberIds: ReadonlyArray<string>;
  readonly records: Readonly<Record<RecordTable, ReadonlyArray<SourceRecord>>>;
  readonly positions: ReadonlyArray<StoredRow>;
  readonly contexts: ReadonlyArray<StoredRow>;
  readonly threadDigests: ReadonlyMap<string, string>;
  readonly digest: string;
}
export const TABLE_KEYS = {
  threads: "thread_id",
  runs: "run_id",
  run_attempts: "attempt_id",
  nodes: "node_id",
  subagents: "subagent_id",
  provider_turns: "provider_turn_id",
  runtime_requests: "runtime_request_id",
  messages: "message_id",
  plans: "plan_id",
  turn_items: "turn_item_id",
  context_handoffs: "context_handoff_id",
  context_transfers: "context_transfer_id",
} as const;
export const EVENT_TYPES = {
  threads: "thread.created",
  runs: "run.created",
  run_attempts: "run-attempt.created",
  nodes: "node.updated",
  subagents: "subagent.updated",
  provider_turns: "provider-turn.updated",
  runtime_requests: "runtime-request.updated",
  messages: "message.updated",
  plans: "plan.updated",
  turn_items: "turn-item.updated",
  context_handoffs: "context-handoff.updated",
  context_transfers: "context-transfer.created",
} as const;

export function structuralReferences(
  events: ReadonlyArray<C.OrchestrationV2DomainEvent>,
  contexts: ReadonlyArray<{ readonly thread_id: string; readonly item_id: string }>,
) {
  const groups = new Map<
    string,
    { table: string; columns: ReadonlyArray<string>; keys: string[][] }
  >();
  const add = (
    table: string,
    columns: ReadonlyArray<string>,
    keys: ReadonlyArray<string | null | undefined>,
  ) => {
    if (keys.some((key) => key == null)) return;
    const groupKey = JSON.stringify([table, columns]);
    const group = groups.get(groupKey) ?? { table, columns, keys: [] };
    group.keys.push(keys.map(String));
    groups.set(groupKey, group);
  };
  const thread = (id: string | null | undefined) =>
    add(PROJECTION_PREFIX + "threads", ["thread_id"], [id]);
  const point = (value: C.OrchestrationV2ContextSourcePoint) => {
    thread(value.threadId);
    if (value.runId !== undefined)
      add(PROJECTION_PREFIX + "runs", ["run_id", "thread_id"], [value.runId, value.threadId]);
    if (value.turnItemId !== undefined)
      add(
        PROJECTION_PREFIX + "turn_items",
        ["turn_item_id", "thread_id"],
        [value.turnItemId, value.threadId],
      );
  };
  for (const event of events)
    switch (event.type) {
      case "thread.created": {
        thread(event.payload.lineage.rootThreadId);
        thread(event.payload.lineage.parentThreadId);
        const fork = event.payload.forkedFrom;
        if (fork?.type === "run")
          add(PROJECTION_PREFIX + "runs", ["run_id", "thread_id"], [fork.runId, fork.threadId]);
        if (fork?.type === "node") add(PROJECTION_PREFIX + "nodes", ["node_id"], [fork.nodeId]);
        break;
      }
      case "run.created":
        if (event.payload.delegatedTaskId !== undefined)
          add(PROJECTION_PREFIX + "subagents", ["subagent_id"], [event.payload.delegatedTaskId]);
        add(
          PROJECTION_PREFIX + "runs",
          ["run_id", "thread_id"],
          [event.payload.manualContinuationOfRunId, event.payload.threadId],
        );
        break;
      case "subagent.updated":
        thread(event.payload.childThreadId);
        break;
      case "context-transfer.created": {
        thread(event.payload.sourceThreadId);
        thread(event.payload.targetThreadId);
        point(event.payload.sourcePoint);
        if (event.payload.basePoint) point(event.payload.basePoint);
        if (event.payload.targetRunId)
          add(
            PROJECTION_PREFIX + "runs",
            ["run_id", "thread_id"],
            [event.payload.targetRunId, event.payload.targetThreadId],
          );
        const resolution = event.payload.resolution;
        if (resolution && "contextHandoffId" in resolution)
          add(
            PROJECTION_PREFIX + "context_handoffs",
            ["context_handoff_id"],
            [resolution.contextHandoffId],
          );
        break;
      }
    }
  for (const context of contexts) {
    thread(context.thread_id);
    add(PROJECTION_PREFIX + "turn_items", ["turn_item_id"], [context.item_id]);
  }
  return [...groups.values()];
}

export const readUnit = Effect.fn("T3ImportService.readUnit")(function* (
  sql: SqlClient.SqlClient,
  rootId: string,
  memberIds: ReadonlyArray<string>,
) {
  const limits = yield* ImportLimits;
  const assertLimit = (name: keyof ImportLimitValues, actual: number) =>
    checkImportLimit(name, actual, limits);
  const ids = encodeJson(memberIds);
  const records = {} as Record<RecordTable, ReadonlyArray<SourceRecord>>;
  const raw = new Map<string, ReadonlyArray<StoredRow>>();
  let rowCount = 0,
    bytes = 0;
  for (const table of [
    ...RECORD_TABLES.map((t) => PROJECTION_PREFIX + t),
    "orchestration_v2_turn_item_positions",
    "mcp_app_model_context",
  ]) {
    const columns = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_xinfo(${table}) WHERE hidden = 0`;
    const where =
      table === PROJECTION_PREFIX + "context_transfers"
        ? "source_thread_id IN (SELECT value FROM json_each(?)) OR target_thread_id IN (SELECT value FROM json_each(?))"
        : "thread_id IN (SELECT value FROM json_each(?))";
    const bindings = table === PROJECTION_PREFIX + "context_transfers" ? [ids, ids] : [ids];
    const aggregate = yield* sql.unsafe<{ readonly count: number; readonly bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(${rowBytesSql(columns.map((c) => c.name))}),0) AS bytes FROM ${quoteIdentifier(table)} WHERE ${where}`,
      bindings,
    );
    rowCount += aggregate[0]?.count ?? 0;
    bytes += aggregate[0]?.bytes ?? 0;
    yield* Effect.try({
      try: () => {
        assertLimit("rows", rowCount);
        assertLimit("unitBytes", bytes);
      },
      catch: (cause) =>
        isImportError(cause) ? cause : new C.T3ImportError({ reason: "too-large", cause }),
    });
  }
  const oversized =
    yield* sql`SELECT 1 FROM t3_import_oversized WHERE thread_id IN (SELECT value FROM json_each(${ids})) OR thread_id IS NULL LIMIT 1`;
  if (oversized.length)
    return yield* new C.T3ImportError({ reason: "too-large", stage: "rowBytes" });
  for (const table of RECORD_TABLES) {
    const where =
      table === "context_transfers"
        ? "source_thread_id IN (SELECT value FROM json_each(?)) OR target_thread_id IN (SELECT value FROM json_each(?))"
        : "thread_id IN (SELECT value FROM json_each(?))";
    const rows = yield* sql.unsafe<StoredRow>(
      `SELECT * FROM ${quoteIdentifier(PROJECTION_PREFIX + table)} WHERE ${where} ORDER BY ${quoteIdentifier(TABLE_KEYS[table])}`,
      table === "context_transfers" ? [ids, ids] : [ids],
    );
    raw.set(table, rows);
    const decoded: SourceRecord[] = [];
    for (const row of rows) {
      const value = yield* Effect.try({
        try: () => readRecord(table, String(row.payload_json)),
        catch: (cause) =>
          isImportError(cause)
            ? cause
            : new C.T3ImportError({ reason: "unreadable-records", stage: table, cause }),
      });
      if (
        value.id !== row[TABLE_KEYS[table]] ||
        (value.threadId !== undefined && value.threadId !== row.thread_id)
      )
        return yield* new C.T3ImportError({
          reason: "unreadable-records",
          stage: `${table}.identity`,
        });
      decoded.push({ row, value });
    }
    records[table] = decoded;
  }
  const positions =
    yield* sql<StoredRow>`SELECT * FROM orchestration_v2_turn_item_positions WHERE thread_id IN (SELECT value FROM json_each(${ids})) ORDER BY thread_id, turn_item_id`;
  const contexts =
    yield* sql<StoredRow>`SELECT * FROM mcp_app_model_context WHERE thread_id IN (SELECT value FROM json_each(${ids})) ORDER BY thread_id, item_id`;
  for (const [schema, rows] of [
    [AUXILIARY_SCHEMAS.positions, positions],
    [AUXILIARY_SCHEMAS.contexts, contexts],
  ] as const)
    for (const row of rows)
      yield* Schema.decodeUnknownEffect(schema)(row).pipe(
        Effect.mapError(
          (cause) =>
            new C.T3ImportError({ reason: "unreadable-records", stage: "auxiliary-row", cause }),
        ),
      );
  raw.set("positions", positions);
  raw.set("contexts", contexts);
  return { rootId, memberIds, records, positions, contexts, raw };
});
export type MaterializedUnit = Effect.Success<ReturnType<typeof readUnit>>;
export function contentDigests(
  unit: MaterializedUnit,
  assets: ReadonlyMap<string, { owner: string; asset: StagedAsset }>,
) {
  const digests = new Map<string, string>();
  for (const thread of unit.memberIds) {
    const hash = NodeCrypto.createHash("sha256");
    const part = (value: string | Uint8Array) => {
      hash.update(String(Buffer.byteLength(value)));
      hash.update(":");
      hash.update(value);
    };
    for (const [table, rows] of unit.raw) {
      part(table);
      for (const row of rows) {
        if (
          row.thread_id !== thread &&
          !(
            table === "context_transfers" &&
            (row.source_thread_id === thread || row.target_thread_id === thread)
          )
        )
          continue;
        for (const [column, value] of Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) {
          if (isDerivedDigestColumn(table, column)) continue;
          part(column);
          part(value instanceof Uint8Array ? "blob" : typeof value);
          part(value instanceof Uint8Array ? value : JSON.stringify(value));
        }
      }
    }
    for (const [key, { owner, asset }] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
      if (owner !== thread) continue;
      part(
        JSON.stringify([
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
    digests.set(thread, hash.digest("hex"));
  }
  return {
    threadDigests: digests,
    digest: digest(
      JSON.stringify([
        digests.get(unit.rootId),
        ...[...digests].filter(([id]) => id !== unit.rootId).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  };
}

export interface AssetReference {
  readonly owner: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly attachment?: C.ChatAttachment;
}
const referenceKey = (ref: AssetReference) =>
  JSON.stringify([
    ref.owner,
    ref.sourceId,
    ref.kind,
    ref.attachment ? [ref.attachment.type, ref.attachment.name, ref.attachment.mimeType] : null,
  ]);
export function assetReferences(unit: MaterializedUnit): ReadonlyMap<string, AssetReference> {
  const refs = new Map<string, AssetReference>();
  const add = (ref: AssetReference) => refs.set(referenceKey(ref), ref);
  for (const table of ["messages", "turn_items"] as const)
    for (const { row, value } of unit.records[table]) {
      const owner = String(row.thread_id);
      if (Array.isArray(value.attachments))
        for (const raw of value.attachments) {
          const attachment = decodeAttachment(raw);
          add({ owner, sourceId: attachment.id, kind: "message", attachment });
        }
      if (isObject(value.questionAnswer) && isObject(value.questionAnswer.attachmentsByQuestionId))
        for (const attachments of Object.values(value.questionAnswer.attachmentsByQuestionId)) {
          if (!Array.isArray(attachments)) continue;
          for (const raw of attachments) {
            const attachment = decodeAttachment(raw);
            add({ owner, sourceId: attachment.id, kind: "answer", attachment });
          }
        }
      if (value.type === "dynamic_tool") {
        const id = toolAssetId({
          toolName: typeof value.toolName === "string" ? value.toolName : null,
          output: value.output,
        });
        if (id !== undefined) add({ owner, sourceId: id, kind: "tool" });
      }
    }
  return refs;
}
function reownAsset(ref: AssetReference, asset: StagedAsset, key: UnitKey): StagedAsset {
  const owner = destinationId(ref.owner, key);
  const base = createDeterministicAttachmentId(
    owner,
    JSON.stringify(["t3-import/3", key, ref.sourceId, ref.kind, asset.selectedRelativeName]),
  );
  const id = `${base}-${asset.actualExtension ?? "missing"}`;
  const finalName = asset.actualExtension ? `${id}.${asset.actualExtension}` : null;
  const messageName = ref.attachment ? attachmentRelativePath({ ...ref.attachment, id }) : null;
  if (finalName && ref.attachment && finalName !== messageName)
    throw new C.T3ImportError({
      reason: "asset-reference-unsupported",
      stage: "destination-reader",
    });
  const names = [
    ...new Set([...attachmentCandidatesById(id), ...(messageName ? [messageName] : [])]),
  ];
  return { ...asset, id, finalName, absenceNames: names.flatMap((name) => [name, name + ".txt"]) };
}

export function reownAssets(
  assets: ReadonlyMap<string, { ref: AssetReference; asset: StagedAsset }>,
  key: UnitKey,
) {
  return new Map([...assets].map(([name, { ref, asset }]) => [name, reownAsset(ref, asset, key)]));
}

export interface MemberSummary {
  readonly latest?: {
    readonly value: {
      readonly id: string;
      readonly status: string;
      readonly rootNodeId: string | null;
      readonly completedAt: string | null;
    };
  };
  readonly failure?: unknown;
  readonly noticeRun?: {
    readonly value: {
      readonly id: string;
      readonly ordinal: number;
      readonly rootNodeId: string | null;
    };
  };
  readonly noticeOrdinal: number;
  readonly lastRunOrdinal: number;
}
export function mapUnit(input: {
  unit: MaterializedUnit;
  key: UnitKey;
  keys: ReadonlyMap<string, UnitKey>;
  owners: Pick<ReadonlyMap<string, string>, "get" | "has">;
  informationalKeys?: ReadonlyMap<string, UnitKey>;
  resolvedPlanRefs?: ReadonlySet<string>;
  projects: ReadonlyMap<string, string>;
  assets: ReadonlyMap<string, { ref: AssetReference; asset: StagedAsset }>;
  ownedTransferIds: ReadonlySet<string>;
  importedAt: string;
  unitDigest: string;
  threadDigests: ReadonlyMap<string, string>;
  dependencies: ReadonlyArray<{ unitRootThreadId: string; generation: number; unitDigest: string }>;
  maxRuntimeMode?: C.RuntimeMode;
  summaries?: ReadonlyMap<string, MemberSummary>;
  counts?: Readonly<Record<string, number>>;
  notices?: boolean;
  limits?: ImportLimitValues;
  mappedAssets?: ReadonlyMap<string, StagedAsset>;
  includeAssets?: boolean;
}) {
  const assertLimit = (name: keyof ImportLimitValues, actual: number) =>
    checkImportLimit(name, actual, input.limits ?? IMPORT_LIMITS);
  const { unit, key } = input;
  const mappedAssets = input.mappedAssets ?? reownAssets(input.assets, key);
  let exclusions = 0,
    unavailableLinks = 0;
  let sourceOwnerForLinks = unit.rootId;
  const informationalLinks = new Map<
    string,
    { sourceOwner: string; destinationThreadId: string; targetUnitRootId: string; count: number }
  >();
  let tableForMap: RecordTable = "threads";
  const map = (
    id: string,
    classification: FieldClass,
    path: string,
    hint?: string,
  ): string | null => {
    if (tableForMap === "context_transfers" && path === "id") return destinationId(id, key);
    if (classification === "placeholder") return destinationId("placeholder:" + id, key);
    if (path === "projectId") return input.projects.get(id) ?? null;
    const owner =
      input.owners.get(id) ?? (input.keys.has(id) || /ThreadId$/.test(path) ? id : hint);
    const ownerKey = owner
      ? (input.keys.get(owner) ??
        (classification === "xref" ? input.informationalKeys?.get(owner) : undefined))
      : undefined;
    if (path === "transferId" && !input.ownedTransferIds.has(id)) {
      exclusions++;
      return null;
    }
    if (classification === "xref" && (/ThreadId$/.test(path) || /(?:^|\.)threadId$/.test(path))) {
      const targetKey = ownerKey ?? ([key[0], owner ?? id, 1] as const);
      const destinationThreadId = destinationId(id, targetKey);
      const linkKey = JSON.stringify([sourceOwnerForLinks, destinationThreadId]);
      const link = informationalLinks.get(linkKey) ?? {
        sourceOwner: sourceOwnerForLinks,
        destinationThreadId,
        targetUnitRootId: targetKey[1],
        count: 0,
      };
      link.count++;
      informationalLinks.set(linkKey, link);
    }
    if (ownerKey) return destinationId(id, ownerKey);
    if (classification === "xref") {
      unavailableLinks++;
      return destinationId(id, [key[0], owner ?? id, 1]);
    }
    // A structural reference without a selected or validated owner must never invent a record.
    throw new C.T3ImportError({ reason: "dependency-changed", stage: path.slice(0, 160) });
  };
  const events: C.OrchestrationV2DomainEvent[] = [];
  const expected = new Map<string, string[][]>(
    [
      ...RECORD_TABLES.map((table) => PROJECTION_PREFIX + table),
      "orchestration_v2_turn_item_positions",
      "mcp_app_model_context",
    ].map((table) => [table, []]),
  );
  const addKey = (table: string, keys: string[]) => {
    const values = expected.get(table) ?? [];
    values.push(keys);
    expected.set(table, values);
  };
  for (const table of RECORD_TABLES)
    for (const { value: original, row } of unit.records[table]) {
      if (table === "context_transfers" && !input.ownedTransferIds.has(String(original.id))) {
        exclusions++;
        continue;
      }
      const sourceOwner = table === "context_transfers" ? unit.rootId : String(row.thread_id);
      sourceOwnerForLinks = sourceOwner;
      let value = { ...original };
      if (
        table === "runs" &&
        isObject(value.sourcePlanRef) &&
        (input.owners.get(String(value.sourcePlanRef.planId)) !==
          String(value.sourcePlanRef.threadId) ||
          (!input.keys.has(String(value.sourcePlanRef.threadId)) &&
            !input.resolvedPlanRefs?.has(String(value.sourcePlanRef.planId))))
      ) {
        delete value.sourcePlanRef;
        exclusions++;
      }

      const replaceAttachments = (raw: unknown, kind: string): unknown => {
        if (!Array.isArray(raw)) return raw;
        return raw.map((a: unknown) => {
          const attachment = decodeAttachment(a);
          const ref = { owner: sourceOwner, sourceId: attachment.id, kind, attachment };
          const asset = mappedAssets.get(referenceKey(ref));
          if (!asset)
            throw new C.T3ImportError({
              reason: "asset-reference-unsupported",
              stage: "asset-map",
            });
          return { ...attachment, id: asset.id };
        });
      };
      if (value.attachments) value.attachments = replaceAttachments(value.attachments, "message");
      if (isObject(value.questionAnswer) && isObject(value.questionAnswer.attachmentsByQuestionId))
        value.questionAnswer = {
          ...value.questionAnswer,
          attachmentsByQuestionId: Object.fromEntries(
            Object.entries(value.questionAnswer.attachmentsByQuestionId).map(([k, a]) => [
              k,
              replaceAttachments(a, "answer"),
            ]),
          ),
        };
      if (value.type === "dynamic_tool") {
        const item = {
          toolName: typeof value.toolName === "string" ? value.toolName : null,
          output: value.output,
        };
        const id = toolAssetId(item);
        if (id !== undefined)
          value.output = rewriteToolAsset(
            item,
            id,
            mappedAssets.get(referenceKey({ owner: sourceOwner, sourceId: id, kind: "tool" }))!.id,
          );
      }
      tableForMap = table;
      const transformed = transformRecord(table, value, map);
      value = transformed.record;
      exclusions += transformed.exclusions;
      if (table === "threads") {
        const mode = decodeRuntimeMode(value.runtimeMode);
        if (input.maxRuntimeMode && C.isRuntimeModeAbove(mode, input.maxRuntimeMode)) {
          value.runtimeMode = input.maxRuntimeMode;
          exclusions++;
        }
        const runs = unit.records.runs.filter((r) => r.row.thread_id === sourceOwner);
        const summary = input.summaries?.get(sourceOwner);
        const latest =
          summary?.latest ??
          runs
            .filter(
              (r) =>
                r.value.status !== "queued" &&
                !(r.value.status === "cancelled" && r.value.startedAt === null),
            )
            .sort(
              (a, b) =>
                String(b.value.completedAt ?? "9999").localeCompare(
                  String(a.value.completedAt ?? "9999"),
                ) || Number(b.value.ordinal) - Number(a.value.ordinal),
            )[0];
        const failure = summary
          ? summary.failure
          : latest?.value.status === "failed"
            ? unit.records.turn_items
                .filter(
                  (r) =>
                    r.row.thread_id === sourceOwner &&
                    r.value.runId === latest.value.id &&
                    r.value.type === "error" &&
                    r.value.status === "failed" &&
                    r.value.nodeId === latest.value.rootNodeId,
                )
                .sort(
                  (a, b) =>
                    String(b.value.updatedAt).localeCompare(String(a.value.updatedAt)) ||
                    Number(b.value.ordinal) - Number(a.value.ordinal),
                )[0]?.value.failure
            : null;
        value.limitRecovery =
          latest &&
          isObject(failure) &&
          failure.class === "usage_limit" &&
          typeof failure.resetAt === "string" &&
          Date.parse(failure.resetAt) >
            Date.parse(String(latest.value.completedAt ?? value.updatedAt))
            ? {
                runId: destinationId(String(latest.value.id), key),
                resetAt: failure.resetAt,
                autoResume: false,
              }
            : null;
        value.importedFrom = {
          app: "t3",
          environmentId: key[0],
          threadId: sourceOwner,
          unitRootThreadId: unit.rootId,
          generation: key[2],
          importedAt: input.importedAt,
          sourceDigest: input.threadDigests.get(sourceOwner)!,
          unitDigest: input.unitDigest,
          dependencyKey: digest(JSON.stringify(input.dependencies)),
          dependencies: input.dependencies,
          importedRowCounts: {},
          ...(sourceOwner === unit.rootId
            ? {
                ownedTransferIds: [...input.ownedTransferIds]
                  .map((id) => destinationId(id, key))
                  .sort(),
              }
            : {}),
          lastRunOrdinal:
            summary?.lastRunOrdinal ?? Math.max(0, ...runs.map((r) => Number(r.value.ordinal))),
        };
      }
      const threadId = destinationId(sourceOwner, key);
      const event = decodeDomainEvent({
        id: destinationId("event:" + original.id, key),
        type: EVENT_TYPES[table],
        threadId,
        occurredAt: input.importedAt,
        payload: value,
      });
      events.push(event);
      addKey(PROJECTION_PREFIX + table, [String(value.id)]);
    }
  const positions = unit.positions.map((row) => ({
    thread_id: destinationId(String(row.thread_id), key),
    turn_item_id: destinationId(String(row.turn_item_id), key),
    ordinal: Number(row.ordinal),
  }));
  if (input.notices !== false)
    for (const thread of unit.memberIds) {
      const summary = input.summaries?.get(thread);
      const runs = events
        .filter(
          (event) => event.type === "run.created" && event.threadId === destinationId(thread, key),
        )
        .map((event) => event.payload as C.OrchestrationV2Run);
      const summaryRun = summary?.noticeRun?.value;
      const run = summaryRun
        ? {
            id: destinationId(String(summaryRun.id), key),
            ordinal: Number(summaryRun.ordinal),
            rootNodeId:
              summaryRun.rootNodeId === null ? null : destinationId(summaryRun.rootNodeId, key),
          }
        : runs
            .filter((run) => run.status !== "rolled_back")
            .sort((a, b) => b.ordinal - a.ordinal)[0];
      const ownItems = events
        .filter(
          (event) =>
            event.type === "turn-item.updated" &&
            event.threadId === destinationId(thread, key) &&
            event.payload.runId === (run?.id ?? null),
        )
        .map((event) => event.payload as C.OrchestrationV2TurnItem);
      const ordinal =
        summary?.noticeOrdinal ??
        Math.max(
          run ? run.ordinal * 1_000_000 : 0,
          ...ownItems.map((item) => item.ordinal),
          ...unit.positions
            .filter((position) => position.thread_id === thread)
            .map((position) => Number(position.ordinal)),
        ) + 1;
      const noticeId = destinationId("notice:" + thread, key);
      const event = decodeDomainEvent({
        id: destinationId("notice-event:" + thread, key),
        type: "turn-item.updated",
        threadId: destinationId(thread, key),
        occurredAt: input.importedAt,
        payload: {
          id: noticeId,
          threadId: destinationId(thread, key),
          runId: run?.id ?? null,
          nodeId: run?.rootNodeId ?? null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: input.importedAt,
          updatedAt: input.importedAt,
          type: "system_notice",
          message: `Imported from T3 Code on ${input.importedAt.slice(0, 10)}. This is history: U4 did not resume T3 provider sessions, worktrees, or checkpoints. Your next message starts a new provider session that receives a summary of the newest conversation text (about 16,000 tokens by default). Older text and tool details stay here but are not sent.`,
        },
      });
      events.push(event);
      addKey(PROJECTION_PREFIX + "turn_items", [noticeId]);
      positions.push({ thread_id: destinationId(thread, key), turn_item_id: noticeId, ordinal });
    }
  for (const position of positions)
    addKey("orchestration_v2_turn_item_positions", [position.thread_id, position.turn_item_id]);
  const contexts = unit.contexts.map(
    (
      row,
    ): Record<string, string | number | null | Uint8Array> & {
      thread_id: string;
      item_id: string;
    } => {
      const owner = input.owners.get(String(row.item_id));
      const itemKey = owner && input.keys.get(owner);
      if (!itemKey)
        throw new C.T3ImportError({ reason: "dependency-changed", stage: "mcp-context-item" });
      const result = {
        ...row,
        thread_id: destinationId(String(row.thread_id), key),
        item_id: destinationId(String(row.item_id), itemKey),
      };
      addKey("mcp_app_model_context", [result.thread_id, result.item_id]);
      return result;
    },
  );
  const counts =
    input.counts ?? Object.fromEntries([...expected].map(([table, keys]) => [table, keys.length]));
  const finalEvents = events.map((event) =>
    event.type === "thread.created"
      ? {
          ...event,
          payload: {
            ...event.payload,
            importedFrom: { ...event.payload.importedFrom!, importedRowCounts: counts },
          },
        }
      : event,
  );
  assertLimit(
    "rows",
    [...expected.values()].reduce((total, rows) => total + rows.length, 0),
  );
  let payloadBytes = 0;
  for (const event of finalEvents) {
    const bytes = Buffer.byteLength(encodeDomainEvent(event));
    assertLimit("rowBytes", bytes);
    payloadBytes += bytes;
  }
  assertLimit("unitBytes", payloadBytes);
  return {
    events: finalEvents,
    positions,
    contexts,
    expected,
    assets: input.includeAssets === false ? [] : [...mappedAssets.values()],
    exclusions,
    unavailableLinks,
    informationalLinks: [...informationalLinks.values()],
  };
}
