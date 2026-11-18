// @effect-diagnostics nodeBuiltinImport:off
// Publication and source anchoring require descriptor-level Node filesystem operations.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { openExclusiveSqliteLock } from "../../persistence/exclusiveSqliteLock.ts";
import {
  forEachSourcePage,
  SOURCE_TABLES,
  sourceTableName,
  sourceKeyColumns,
} from "./t3ImportPaging.ts";
import {
  sourceSummary,
  streamDigests,
  streamMapped,
  pageOwners,
  emptyUnit,
} from "./t3ImportStreaming.ts";
import { buildMappedUnit } from "./T3ImportMappedUnit.ts";

import * as C from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { runtimeModeCeilingRefusal } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as T3ImportStaging from "./T3ImportStaging.ts";
import * as Publisher from "./T3ImportPublisher.ts";
import { encodeJson, isObject } from "./t3ImportFieldMap.ts";
import { stageAsset, type StagedAsset } from "./t3ImportAssets.ts";
import { mapUnit, TABLE_KEYS, type AssetReference } from "./t3ImportRecords.ts";
import {
  assertLimit as checkImportLimit,
  destinationId,
  digest,
  ImportLimits,
  pageRows,
  PROJECTION_PREFIX,
  quoteIdentifier,
  rowBytesSql,
  type UnitKey,
} from "./t3ImportPlan.ts";

type Method = keyof typeof C.T3ImportInputs;
type Input<M extends Method> = (typeof C.T3ImportInputs)[M]["Type"];
type Output<M extends Method> = (typeof C.T3ImportOutputs)[M]["Type"];
type Methods = {
  readonly [M in Method]: (input: Input<M>) => Effect.Effect<Output<M>, C.T3ImportError>;
};
export class T3ImportService extends Context.Service<
  T3ImportService,
  Methods & {
    readonly awaitReady: (sessionId: C.T3ImportSessionId) => Effect.Effect<void, C.T3ImportError>;
    readonly awaitJob: (jobId: C.T3ImportJobId) => Effect.Effect<void, C.T3ImportError>;
  }
>()("t3/u4/t3Import/T3ImportService") {}

export const ImportHooks = Context.Reference<{
  readonly milestone?: (
    stage:
      | "assets-published"
      | "before-commit"
      | "before-gate"
      | "after-commit"
      | "outcome"
      | "after-unit-staging"
      | "mid-bulk"
      | "before-detach",
    rootId: string,
  ) => Effect.Effect<void, C.T3ImportError>;
}>("t3/u4/t3Import/T3ImportService/Hooks", { defaultValue: () => ({}) });

interface Member {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly parent: string | null;
  readonly attached: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
}
interface PlannedUnit {
  readonly rootId: string;
  readonly ownedTransferIds: ReadonlySet<string>;
  readonly key: UnitKey;
  readonly digest: string;
  readonly threadDigests: ReadonlyMap<string, string>;
  readonly dependencies: ReadonlyArray<{
    unitRootThreadId: string;
    generation: number;
    unitDigest: string;
  }>;
  readonly dependencyRoots: ReadonlyArray<string>;
  readonly status: string;
  readonly action: "import" | "skip" | "block";
  readonly block?: C.T3ImportError;
  readonly expectedKeysDigest?: string;
  readonly summary: Effect.Success<ReturnType<typeof sourceSummary>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly exclusions: number;
  readonly unavailableLinks: number;
  readonly informationalLinks: ReturnType<typeof mapUnit>["informationalLinks"];
  readonly members: ReadonlyArray<Member>;
  readonly assets: ReadonlyMap<string, { ref: AssetReference; asset: StagedAsset }>;
}
interface ProjectMapping {
  readonly source: string;
  readonly destination: C.ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly create: boolean;
}
interface Plan {
  readonly id: C.T3ImportPlanId;
  readonly sessionId: C.T3ImportSessionId;
  readonly selection: C.T3ImportSelection;
  readonly units: ReadonlyArray<PlannedUnit>;
  readonly projects: ReadonlyArray<ProjectMapping>;
  readonly blockedMembers: ReadonlyArray<{
    readonly member: Member;
    readonly error: C.T3ImportError;
  }>;
  readonly skippedMembers: ReadonlyArray<Member>;
  readonly preview: C.T3ImportPreview;
  readonly rows: Readonly<Record<C.T3ImportSection, ReadonlyArray<C.T3ImportRow>>>;
}
interface Session {
  readonly id: C.T3ImportSessionId;
  readonly scope: Scope.Closeable;
  readonly directory: string;
  readonly ready: Deferred.Deferred<T3ImportStaging.StagedSource, C.T3ImportError>;
  readonly closed: Deferred.Deferred<void>;
  readonly importedAt: string;
  status: "preparing" | "ready" | "failed";
  source?: T3ImportStaging.StagedSource;
  error?: C.T3ImportError;
  plan?: Plan;
  readonly assets: Map<string, { ref: AssetReference; asset: StagedAsset }>;
  touchedAt: number;
}
interface Job {
  readonly id: C.T3ImportJobId;
  readonly plan: Plan;
  readonly done: Deferred.Deferred<void, C.T3ImportError>;
  status: C.T3ImportJob["status"];
  cancelled: boolean;
  readonly results: C.T3ImportResult[];
  readonly unavailableLinkRows: C.T3ImportRow[];
}
const isImportError = Schema.is(C.T3ImportError);
const decodeThread = Schema.decodeUnknownEffect(C.OrchestrationV2AppThreadJson);
const importError = (cause: unknown) =>
  isImportError(cause)
    ? cause
    : new C.T3ImportError({ reason: "staging-failed", stage: "import", cause });
const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: importError });
const attempt = <A>(f: () => A) => Effect.try({ try: f, catch: importError });
const normalizedRoot = (root: string) =>
  NodePath.resolve(
    root === "~"
      ? NodeOS.homedir()
      : root.startsWith("~/")
        ? NodePath.join(NodeOS.homedir(), root.slice(2))
        : root,
  );

const make = Effect.gen(function* () {
  const limits = yield* ImportLimits;
  const assertLimit = (name: keyof typeof limits, actual: number) =>
    checkImportLimit(name, actual, limits);
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const staging = yield* T3ImportStaging.T3ImportStaging;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const hooks = yield* ImportHooks;
  const paths: Publisher.PublicationPaths = config;
  let session: Session | undefined, job: Job | undefined;
  const running = () => job?.status === "running" || job?.status === "cancelling";
  const milestone = (stage: Parameters<NonNullable<typeof hooks.milestone>>[0], root: string) =>
    hooks.milestone?.(stage, root) ?? Effect.void;
  const lifetime = NodeSqliteClient.importAttachmentLifetime(sql);
  let admission: ReturnType<typeof openExclusiveSqliteLock> | undefined;
  let initialized = false;
  let journalBlocked = false;
  const pinnedDirectories = new Set<string>();
  let importerClosed = false;
  const ownerPath = NodePath.join(config.stateDir, "imports", "t3", "owner.sqlite");
  const acquireAdmission = io(async () => {
    await NodeFSP.mkdir(NodePath.dirname(ownerPath), { recursive: true, mode: 0o700 });
    try {
      const next = openExclusiveSqliteLock(ownerPath, 0, 0o600);
      if (next.replacedDuringAcquire) {
        next.db.close();
        throw new C.T3ImportError({ reason: "busy", stage: "import-owner" });
      }
      admission = next;
    } catch (cause) {
      if (cause instanceof Error && "errcode" in cause && Number(cause.errcode) % 256 === 5) return;
      throw cause;
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      importerClosed = true;
      admission?.db.close();
      admission = undefined;
    }),
  );
  const verifyAdmission = Effect.fn("T3ImportService.verifyAdmission")(function* () {
    if (!admission) return yield* new C.T3ImportError({ reason: "busy", stage: "import-owner" });
    const stat = yield* io(() => NodeFSP.lstat(ownerPath, { bigint: true }));
    if (stat.dev !== admission.identity.dev || stat.ino !== admission.identity.ino)
      return yield* new C.T3ImportError({ reason: "busy", stage: "import-owner" });
  });
  const requireSession = Effect.fn("T3ImportService.requireSession")(function* (
    id: C.T3ImportSessionId,
  ) {
    yield* ensureAdmission();
    if (!session || session.id !== id)
      return yield* new C.T3ImportError({ reason: "session-not-found" });
    session.touchedAt = yield* Clock.currentTimeMillis;
    return session;
  });
  const requireReady = Effect.fn("T3ImportService.requireReady")(function* (
    id: C.T3ImportSessionId,
  ) {
    const current = yield* requireSession(id);
    if (current.status !== "ready" || !current.source)
      return yield* current.error ?? new C.T3ImportError({ reason: "not-ready" });
    return { session: current, source: current.source };
  });
  const outcome = Effect.fn("T3ImportService.outcome")(function* (key: UnitKey) {
    yield* milestone("outcome", key[1]);
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${destinationId(key[1], key)}`;
    if (!rows[0]) return "absent" as const;
    const value: unknown = yield* attempt(() => JSON.parse(rows[0]!.payload_json));
    if (
      !isObject(value) ||
      !isObject(value.importedFrom) ||
      value.importedFrom.environmentId !== key[0] ||
      value.importedFrom.unitRootThreadId !== key[1] ||
      value.importedFrom.generation !== key[2]
    )
      return yield* new C.T3ImportError({ reason: "unknown", stage: "outcome-provenance" });
    return "committed" as const;
  }, Effect.mapError(importError));
  const reconcile = Effect.fn("T3ImportService.reconcile")(function* (key: UnitKey) {
    const prior = yield* io(() => Publisher.loadPublication(paths, key));
    if (!prior) return;
    const resolved = yield* outcome(key).pipe(Effect.orElseSucceed(() => "unknown" as const));
    yield* io(() => Publisher.finishPublication(paths, prior, resolved));
  });
  const initialize = Effect.fn("T3ImportService.initialize")(function* () {
    if (initialized) return;
    const startup = yield* io(() => Publisher.listPublications(paths)).pipe(Effect.result);
    journalBlocked = startup._tag === "Failure";
    if (startup._tag === "Success")
      for (const entry of startup.success) {
        const result = yield* reconcile(entry.unitKey).pipe(Effect.result);
        if (result._tag === "Failure") journalBlocked = true;
      }
    if (!journalBlocked)
      yield* io(() =>
        NodeFSP.rm(NodePath.join(config.stateDir, "imports", "t3", "sessions"), {
          recursive: true,
          force: true,
        }),
      );
    initialized = true;
  });
  const ensureAdmission = Effect.fn("T3ImportService.ensureAdmission")(function* (retry = false) {
    if (lifetime?.retained() && !(yield* lifetime.retry))
      return yield* new C.T3ImportError({ reason: "busy", stage: "cleanup-blocked" });
    if (!admission && retry) {
      yield* acquireAdmission;
      initialized = false;
    }
    yield* verifyAdmission();
    yield* initialize();
  });
  if (!lifetime?.retained()) {
    yield* acquireAdmission;
    if (admission) {
      yield* verifyAdmission();
      yield* initialize();
    }
  }
  yield* Effect.addFinalizer(() => (session ? Scope.close(session.scope, Exit.void) : Effect.void));

  const disposeSession = Effect.fn("T3ImportService.disposeSession")(function* (current: Session) {
    yield* Deferred.succeed(current.closed, undefined);
    yield* Scope.close(current.scope, Exit.void);
    if (!pinnedDirectories.has(current.directory))
      yield* io(() => NodeFSP.rm(current.directory, { recursive: true, force: true }));
  });
  const expireSession = Effect.fn("T3ImportService.expireSession")(function* (current: Session) {
    for (;;) {
      if (session !== current) return;
      if (running() && job) {
        yield* Deferred.await(job.done).pipe(Effect.ignore);
        continue;
      }
      const remaining = current.touchedAt + 30 * 60_000 - (yield* Clock.currentTimeMillis);
      if (remaining > 0) {
        yield* Effect.sleep(remaining);
        continue;
      }
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            session !== current ||
            running() ||
            (yield* Clock.currentTimeMillis) < current.touchedAt + 30 * 60_000
          )
            return;
          yield* disposeSession(current);
          session = undefined;
          job = undefined;
        }),
      );
      if (session !== current) return;
    }
  });

  const readMember = Effect.fn("T3ImportService.readMember")(function* (
    source: T3ImportStaging.StagedSource,
    id: string,
  ) {
    const rows = yield* source.sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly title: string;
      readonly payload_json: string;
      readonly created_at: string;
      readonly deleted_at: string | null;
    }>`SELECT thread_id, project_id, title, payload_json, created_at, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${id}`;
    const row = rows[0];
    if (!row)
      return yield* new C.T3ImportError({ reason: "invalid-lineage", stage: "missing-thread" });
    const value = yield* decodeThread(yield* attempt(() => JSON.parse(row.payload_json)));
    const lineage = value.lineage;
    return {
      id,
      projectId: row.project_id,
      title: row.title,
      parent: typeof lineage.parentThreadId === "string" ? lineage.parentThreadId : null,
      attached: lineage.relationshipToParent === "subagent" || lineage.sideChat === true,
      deleted: row.deleted_at !== null,
      createdAt: row.created_at,
    } satisfies Member;
  }, Effect.mapError(importError));

  const visitExpected = Effect.fn("T3ImportService.visitExpected")(function* (
    unit: PlannedUnit,
    consume: (
      table: string,
      keys: ReadonlyArray<ReadonlyArray<string>>,
    ) => Effect.Effect<void, C.T3ImportError | SqlError>,
  ) {
    const source = session!.source!.sql;
    for (const table of SOURCE_TABLES) {
      const name = sourceTableName(table);
      yield* forEachSourcePage(
        source,
        unit.members.map((member) => member.id),
        table,
        (rows) =>
          Effect.gen(function* () {
            const owners =
              table === "contexts"
                ? yield* pageOwners(source, { ...emptyUnit(unit.rootId), contexts: rows })
                : new Map<string, string>();
            const keys: string[][] = [];
            for (const row of rows) {
              if (
                table === "context_transfers" &&
                !unit.ownedTransferIds.has(String(row.context_transfer_id))
              )
                continue;
              if (table === "contexts") {
                const owner = owners.get(String(row.item_id));
                let root = owner;
                const seen = new Set<string>();
                while (
                  root &&
                  !seen.has(root) &&
                  seen.size <= limits.depth &&
                  !unit.members.some((member) => member.id === root) &&
                  !unit.dependencies.some((dependency) => dependency.unitRootThreadId === root)
                ) {
                  seen.add(root);
                  const parent = yield* source<{
                    parent: string | null;
                    attached: number;
                  }>`SELECT json_extract(payload_json,'$.lineage.parentThreadId') AS parent,json_extract(payload_json,'$.lineage.relationshipToParent') = 'subagent' OR json_extract(payload_json,'$.lineage.sideChat') = 1 AS attached FROM orchestration_v2_projection_threads WHERE thread_id = ${root}`;
                  if (!parent[0]?.attached || !parent[0].parent) break;
                  root = parent[0].parent;
                }
                const dependency = unit.dependencies.find(
                  (dependency) => dependency.unitRootThreadId === root,
                );
                const key =
                  owner && unit.members.some((member) => member.id === owner)
                    ? unit.key
                    : dependency
                      ? ([unit.key[0], dependency.unitRootThreadId, dependency.generation] as const)
                      : undefined;
                if (!key)
                  return yield* new C.T3ImportError({
                    reason: "dependency-changed",
                    stage: "mcp-context-item",
                  });
                keys.push([
                  destinationId(String(row.thread_id), unit.key),
                  destinationId(String(row.item_id), key),
                ]);
              } else
                keys.push(
                  sourceKeyColumns(table).map((column) =>
                    destinationId(String(row[column]), unit.key),
                  ),
                );
            }
            yield* consume(name, keys);
          }),
        true,
      );
      if (table === "positions" || table === "turn_items")
        yield* consume(
          name,
          unit.members.map((member) =>
            table === "positions"
              ? [destinationId(member.id, unit.key), destinationId("notice:" + member.id, unit.key)]
              : [destinationId("notice:" + member.id, unit.key)],
          ),
        );
    }
  });
  const intact = Effect.fn("T3ImportService.intact")(function* (
    unit: PlannedUnit,
    existing: Record<string, unknown>,
    staged = false,
  ) {
    const provenance = existing.importedFrom;
    if (
      !isObject(provenance) ||
      !Array.isArray(provenance.ownedTransferIds) ||
      new Set(provenance.ownedTransferIds).size !== provenance.ownedTransferIds.length ||
      Buffer.byteLength(encodeJson(provenance.ownedTransferIds)) > limits.ownershipBytes
    )
      return false;
    const candidates = new Set([...unit.ownedTransferIds].map((id) => destinationId(id, unit.key)));
    if (provenance.ownedTransferIds.some((id) => typeof id !== "string" || !candidates.has(id)))
      return false;
    const counts = isObject(provenance.importedRowCounts) ? provenance.importedRowCounts : {};
    if (counts[PROJECTION_PREFIX + "context_transfers"] !== provenance.ownedTransferIds.length)
      return false;
    for (const member of unit.members) {
      const rows = yield* sql<{
        readonly payload_json: string;
        readonly deleted_at: string | null;
      }>`SELECT payload_json, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${destinationId(member.id, unit.key)}`;
      if (!rows[0] || (rows[0].deleted_at !== null) !== member.deleted) return false;
      const value: unknown = yield* attempt(() => JSON.parse(rows[0]!.payload_json));
      if (
        !isObject(value) ||
        !isObject(value.importedFrom) ||
        value.importedFrom.unitRootThreadId !== unit.rootId ||
        value.importedFrom.generation !== unit.key[2] ||
        value.importedFrom.environmentId !== unit.key[0]
      )
        return false;
    }
    let complete = true;
    const foundCounts = new Map<string, number>();
    const check = Effect.fn("T3ImportService.checkExpected")(function* (
      table: string,
      keys: ReadonlyArray<ReadonlyArray<string>>,
    ) {
      foundCounts.set(table, (foundCounts.get(table) ?? 0) + keys.length);
      const columns =
        table === "mcp_app_model_context"
          ? ["thread_id", "item_id"]
          : table === "orchestration_v2_turn_item_positions"
            ? ["thread_id", "turn_item_id"]
            : [TABLE_KEYS[table.slice(PROJECTION_PREFIX.length) as keyof typeof TABLE_KEYS]];
      for (let offset = 0; offset < keys.length; offset += 500) {
        const batch = keys.slice(offset, offset + 500);
        const rows = yield* sql.unsafe<{ count: number }>(
          `SELECT COUNT(*) AS count FROM json_each(?) expected WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(table)} dest WHERE ${columns.map((column, index) => `dest.${quoteIdentifier(column)} = json_extract(expected.value,'$[${index}]')`).join(" AND ")})`,
          [encodeJson(batch)],
        );
        if (rows[0]?.count !== batch.length) complete = false;
      }
    });
    if (!staged) yield* visitExpected(unit, check);
    else
      for (const table of SOURCE_TABLES.map(sourceTableName)) {
        const columns =
          table === "mcp_app_model_context"
            ? ["thread_id", "item_id"]
            : table === "orchestration_v2_turn_item_positions"
              ? ["thread_id", "turn_item_id"]
              : [TABLE_KEYS[table.slice(PROJECTION_PREFIX.length) as keyof typeof TABLE_KEYS]];
        const rows = yield* sql.unsafe<{ count: number; missing: number }>(
          `SELECT COUNT(*) AS count, COALESCE(SUM(NOT EXISTS (SELECT 1 FROM main.${quoteIdentifier(table)} dest WHERE ${columns.map((column, index) => `dest.${quoteIdentifier(column)} = expected.k${index + 1}`).join(" AND ")})),0) AS missing FROM t3i_unit.t3i_dependency_keys expected WHERE dep = ? AND tbl = ?`,
          [unit.rootId, table],
        ).unprepared;
        foundCounts.set(table, rows[0]!.count);
        if (rows[0]!.missing) complete = false;
      }
    for (const table of SOURCE_TABLES.map(sourceTableName))
      if (counts[table] !== (foundCounts.get(table) ?? 0)) complete = false;
    return complete;
  });

  const buildPlan = Effect.fn("T3ImportService.buildPlan")(function* (
    current: Session,
    source: T3ImportStaging.StagedSource,
    selection: C.T3ImportSelection,
  ) {
    const requested = new Set<string>(selection.threadIds);
    const selectedCount = yield* source.sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM (
      SELECT value AS thread_id FROM json_each(${encodeJson(selection.threadIds)})
      UNION SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE project_id IN (SELECT value FROM json_each(${encodeJson(selection.projectIds)})) AND deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent' AND json_extract(payload_json, '$.lineage.sideChat') IS NOT 1 ELSE 1 END
    ) WHERE thread_id NOT IN (SELECT value FROM json_each(${encodeJson(selection.excludeThreadIds)}))`;
    yield* attempt(() => assertLimit("threads", selectedCount[0]!.count));
    if (selection.projectIds.length) {
      const expanded = yield* source.sql<{
        readonly thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE project_id IN (SELECT value FROM json_each(${encodeJson(selection.projectIds)})) AND deleted_at IS NULL
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent' AND json_extract(payload_json, '$.lineage.sideChat') IS NOT 1 ELSE 1 END
        ORDER BY thread_id`;
      for (const row of expanded) requested.add(row.thread_id);
    }
    for (const id of selection.excludeThreadIds) requested.delete(id);
    yield* attempt(() => assertLimit("threads", requested.size));
    const closure = yield* source.sql<{
      readonly count: number;
    }>`WITH RECURSIVE closed(thread_id) AS (
      SELECT value FROM json_each(${encodeJson([...requested])})
      UNION SELECT related.thread_id FROM closed current
      JOIN orchestration_v2_projection_threads thread ON thread.thread_id = current.thread_id
      JOIN orchestration_v2_projection_threads related ON
        CASE WHEN json_valid(thread.payload_json) THEN related.thread_id = json_extract(thread.payload_json, '$.lineage.parentThreadId') ELSE 0 END
        OR CASE WHEN json_valid(related.payload_json) THEN json_extract(related.payload_json, '$.lineage.parentThreadId') = current.thread_id
          AND (json_extract(related.payload_json, '$.lineage.relationshipToParent') = 'subagent' OR json_extract(related.payload_json, '$.lineage.sideChat') = 1) ELSE 0 END
    ) SELECT COUNT(*) AS count FROM closed`;
    yield* attempt(() => assertLimit("threads", closure[0]!.count));
    const skippedMembers: Member[] = [];
    const isEmptySideChat = Effect.fn("T3ImportService.isEmptySideChat")(function* (id: string) {
      const rows =
        yield* source.sql`SELECT 1 FROM orchestration_v2_projection_threads thread WHERE thread_id = ${id}
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.sideChat') = 1 ELSE 0 END
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.thread_id = thread.thread_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages message WHERE message.thread_id = thread.thread_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads child WHERE CASE WHEN json_valid(child.payload_json) THEN json_extract(child.payload_json, '$.lineage.parentThreadId') = thread.thread_id ELSE 0 END)`;
      return rows.length > 0;
    });
    for (const id of requested)
      if (yield* isEmptySideChat(id)) {
        requested.delete(id);
        skippedMembers.push(yield* readMember(source, id));
      }
    const members = new Map<string, Member>();
    const unitRoots = new Map<string, string>();
    const resolveRoot = Effect.fn("T3ImportService.resolveRoot")(function* (id: string) {
      let at = id;
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(at) || seen.size > limits.depth)
          return yield* new C.T3ImportError({ reason: "invalid-lineage", stage: "attached-cycle" });
        seen.add(at);
        const member = members.get(at) ?? (yield* readMember(source, at));
        members.set(at, member);
        if (!member.attached || !member.parent) {
          for (const child of seen) unitRoots.set(child, at);
          return at;
        }
        at = member.parent;
      }
    });
    const roots = new Set<string>();
    for (const id of requested) roots.add(yield* resolveRoot(id));
    const rootMembers = new Map<string, Member[]>(),
      ancestors = new Map<string, string[]>();
    const visit = Effect.fn("T3ImportService.closeUnit")(function* (
      root: string,
      chain: ReadonlyArray<string>,
    ): Effect.fn.Return<void, C.T3ImportError | SqlError> {
      if (chain.includes(root) || chain.length > limits.depth)
        return yield* new C.T3ImportError({ reason: "invalid-lineage", stage: "fork-cycle" });
      if (rootMembers.has(root)) return;
      const own: Member[] = [members.get(root) ?? (yield* readMember(source, root))];
      for (let index = 0; index < own.length; index++) {
        const children = yield* source.sql<{
          readonly thread_id: string;
        }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') = ${own[index]!.id}
          AND (json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' OR json_extract(payload_json, '$.lineage.sideChat') = 1) ELSE 0 END ORDER BY thread_id LIMIT 301`;
        for (const child of children) {
          if (yield* isEmptySideChat(child.thread_id)) {
            if (!skippedMembers.some((member) => member.id === child.thread_id))
              skippedMembers.push(yield* readMember(source, child.thread_id));
            continue;
          }
          if (own.some((m) => m.id === child.thread_id))
            return yield* new C.T3ImportError({ reason: "invalid-lineage", stage: "child-cycle" });
          own.push(yield* readMember(source, child.thread_id));
        }
        yield* attempt(() =>
          assertLimit(
            "threads",
            own.length + [...rootMembers.values()].reduce((n, rows) => n + rows.length, 0),
          ),
        );
      }
      rootMembers.set(root, own);
      for (const member of own) {
        members.set(member.id, member);
        unitRoots.set(member.id, root);
      }
      const rootMember = own[0]!;
      if (rootMember.parent) {
        const ancestor = yield* resolveRoot(rootMember.parent);
        yield* visit(ancestor, [...chain, root]);
        ancestors.set(root, [ancestor, ...(ancestors.get(ancestor) ?? [])]);
      } else ancestors.set(root, []);
    });
    for (const root of roots) yield* visit(root, []);
    yield* attempt(() => {
      assertLimit("units", rootMembers.size);
      assertLimit("threads", members.size);
    });
    const ordered = [...rootMembers.keys()].sort(
      (a, b) =>
        (ancestors.get(a)?.length ?? 0) - (ancestors.get(b)?.length ?? 0) ||
        members.get(a)!.createdAt.localeCompare(members.get(b)!.createdAt) ||
        a.localeCompare(b),
    );
    const mappings: ProjectMapping[] = [];
    const projectErrors = new Map<string, C.T3ImportError>();
    for (const projectId of new Set([...members.values()].map((m) => m.projectId))) {
      const rows = yield* source.sql<{
        readonly title: string;
        readonly workspace_root: string;
      }>`SELECT title, workspace_root FROM projection_projects WHERE project_id = ${projectId}`;
      if (!rows[0])
        return yield* new C.T3ImportError({
          reason: "dependency-changed",
          stage: "source-project",
        });
      const workspaceRoot = normalizedRoot(rows[0].workspace_root);
      const chosen = selection.projectMapping.find(
        (m) => m.sourceProjectId === projectId,
      )?.destination;
      const destination =
        chosen?.type === "existing"
          ? yield* sql<{
              readonly project_id: string;
              readonly workspace_root: string;
            }>`SELECT project_id, workspace_root FROM projection_projects WHERE project_id = ${chosen.projectId} AND deleted_at IS NULL`
          : yield* sql<{
              readonly project_id: string;
              readonly workspace_root: string;
            }>`SELECT project_id, workspace_root FROM projection_projects WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL`;
      if (chosen?.type === "existing" && !destination[0])
        return yield* new C.T3ImportError({
          reason: "dependency-changed",
          stage: "destination-project",
        });
      if (chosen?.type !== "existing" && !destination[0]) {
        const stat = yield* io(async () => {
          try {
            return await NodeFSP.stat(workspaceRoot);
          } catch {
            return null;
          }
        });
        if (!stat?.isDirectory())
          projectErrors.set(
            projectId,
            new C.T3ImportError({ reason: "destination-conflict", stage: "workspace-unavailable" }),
          );
      }
      mappings.push({
        source: projectId,
        destination: C.ProjectId.make(
          destination[0]?.project_id ??
            destinationId(
              projectId,
              [source.environmentId, "project:" + projectId + ":" + digest(workspaceRoot), 1],
              "project",
            ),
        ),
        title: rows[0].title,
        workspaceRoot: destination[0]
          ? normalizedRoot(destination[0].workspace_root)
          : workspaceRoot,
        create: !destination[0],
      });
    }
    const projectMap = new Map(mappings.map((m) => [m.source, m.destination]));
    const unitErrors = new Map<string, C.T3ImportError>();
    const recordTotals = { items: 0, runs: 0, mcpContexts: 0 };
    const analyses = new Map<
      string,
      {
        summary: Effect.Success<ReturnType<typeof sourceSummary>>;
        digests: { digest: string; threadDigests: ReadonlyMap<string, string> };
        assets: Map<string, { ref: AssetReference; asset: StagedAsset }>;
        owned: Set<string>;
      }
    >();
    const assetsByRoot = new Map<
      string,
      Map<string, { ref: AssetReference; asset: StagedAsset }>
    >();
    let jobAssetBytes = 0;
    for (const root of ordered) {
      const analyze = Effect.gen(function* () {
        const ids = rootMembers.get(root)!.map((member) => member.id);
        const summary = yield* sourceSummary(source.sql, ids);
        recordTotals.items += summary.counts[PROJECTION_PREFIX + "turn_items"] ?? 0;
        recordTotals.runs += summary.counts[PROJECTION_PREFIX + "runs"] ?? 0;
        recordTotals.mcpContexts += summary.counts.mcp_app_model_context ?? 0;
        const assets = new Map<string, { ref: AssetReference; asset: StagedAsset }>();
        let unitBytes = 0;
        const directory = NodePath.join(current.directory, "assets");
        yield* io(() => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }));
        const owned = new Set<string>();
        const digests = yield* streamDigests(
          source.sql,
          root,
          ids,
          (refs) =>
            Effect.gen(function* () {
              for (const [refKey, ref] of refs) {
                if (assets.has(refKey)) continue;
                yield* attempt(() => assertLimit("assets", assets.size + 1));
                const cacheKey = encodeJson([root, refKey]);
                let cached = current.assets.get(cacheKey);
                if (!cached) {
                  const space = yield* io(() => NodeFSP.statfs(directory));
                  if (space.bavail * space.bsize < (unitBytes + jobAssetBytes) * 1.5)
                    return yield* new C.T3ImportError({
                      reason: "insufficient-space",
                      stage: "assets",
                    });
                  const asset = yield* io(() =>
                    stageAsset({
                      anchors: source.anchors,
                      directory,
                      sourceAssetId: ref.sourceId,
                      kind: ref.kind,
                      ...(ref.attachment ? { attachment: ref.attachment } : {}),
                      ownerThreadId: destinationId(ref.owner, [source.environmentId, root, 1]),
                      unitKey: [source.environmentId, root, 1],
                      remaining: limits.unitAssetBytes - unitBytes,
                    }),
                  );
                  cached = { ref, asset };
                  current.assets.set(cacheKey, cached);
                }
                unitBytes += cached.asset.bytes + (cached.asset.sidecar?.bytes ?? 0);
                assets.set(refKey, cached);
              }
            }),
          assets,
          (table, row) =>
            Effect.gen(function* () {
              if (table !== "context_transfers" || row.status === "pending") return;
              const a = unitRoots.get(String(row.source_thread_id)),
                b = unitRoots.get(String(row.target_thread_id));
              if (
                (a === root && b === root) ||
                (row.type === "fork" && b === root && (ancestors.get(root) ?? []).includes(a ?? ""))
              ) {
                owned.add(String(row.context_transfer_id));
                yield* attempt(() =>
                  assertLimit(
                    "ownershipBytes",
                    Buffer.byteLength(
                      encodeJson(
                        [...owned].map((id) => destinationId(id, [source.environmentId, root, 1])),
                      ),
                    ),
                  ),
                );
              } else if (a !== undefined && b !== undefined && row.type !== "fork")
                return yield* new C.T3ImportError({
                  reason: "invalid-lineage",
                  stage: "cross-unit-transfer",
                });
            }),
        );
        yield* io(source.anchors.revalidate);
        jobAssetBytes += unitBytes;
        yield* attempt(() => {
          assertLimit("unitAssetBytes", unitBytes);
          assertLimit("jobAssetBytes", jobAssetBytes);
        });
        analyses.set(root, { summary, digests, assets, owned });
        assetsByRoot.set(root, assets);
      });
      const result = yield* analyze.pipe(
        Effect.catchDefect((cause) => Effect.fail(importError(cause))),
        Effect.mapError(importError),
        Effect.result,
      );
      if (result._tag === "Failure") unitErrors.set(root, result.failure);
    }
    const candidates = yield* source.projections.findWorkCandidates(
      [...members.keys()].map((id) => C.ThreadId.make(id)),
      { now: yield* DateTime.now },
    );
    for (const candidate of candidates)
      if (candidate.kind !== "usage-limit")
        unitErrors.set(
          unitRoots.get(candidate.threadId)!,
          new C.T3ImportError({ reason: "pending-work", stage: candidate.kind }),
        );
    let informationalLinks = 0;
    const units: PlannedUnit[] = [],
      keys = new Map<string, UnitKey>();
    const rows: Record<C.T3ImportSection, C.T3ImportRow[]> = {
      threads: [],
      dependencies: [],
      mappings: [],
      skipped: [],
      blocked: [],
      exclusions: [],
      warnings: [],
      "unavailable-links": [],
    };
    for (const member of skippedMembers) {
      const row = {
        sourceThreadId: C.ThreadId.make(member.id),
        title: member.title,
        category: "empty-side-chat",
        explanation: "This side chat has no runs or messages to import.",
      };
      rows.threads.push(row);
      rows.skipped.push(row);
    }
    const blockedMembers: Array<{ member: Member; error: C.T3ImportError }> = [];
    for (const root of ordered) {
      const own = rootMembers.get(root)!;
      if (unitErrors.has(root) && !assetsByRoot.has(root)) {
        const error = unitErrors.get(root)!;
        for (const member of own) {
          blockedMembers.push({ member, error });
          rows.threads.push({
            sourceThreadId: C.ThreadId.make(member.id),
            unitRootThreadId: C.ThreadId.make(root),
            title: member.title,
            category: "blocked",
            explanation: error.message,
          });
        }
        rows.blocked.push({
          sourceThreadId: C.ThreadId.make(root),
          unitRootThreadId: C.ThreadId.make(root),
          category: error.reason,
          explanation: error.message,
        });
        continue;
      }
      const analysis = analyses.get(root)!;
      const { summary, digests, assets, owned } = analysis;
      const dependencyRoots = ancestors.get(root) ?? [];
      const dependencies = dependencyRoots.flatMap((r) => {
        const u = units.find((u) => u.rootId === r);
        return u ? [{ unitRootThreadId: r, generation: u.key[2], unitDigest: u.digest }] : [];
      });
      const copies = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.importedFrom.environmentId') = ${source.environmentId}
        AND json_extract(payload_json, '$.importedFrom.unitRootThreadId') = ${root}
        AND json_extract(payload_json, '$.importedFrom.threadId') = ${root}
        ORDER BY json_extract(payload_json, '$.importedFrom.generation') DESC`;
      const existing: unknown = copies[0]
        ? yield* attempt(() => JSON.parse(copies[0]!.payload_json))
        : undefined;
      const provenance =
        isObject(existing) && isObject(existing.importedFrom) ? existing.importedFrom : undefined;
      let generation =
        provenance && Number.isSafeInteger(provenance.generation)
          ? Number(provenance.generation)
          : 0;
      let status = "new",
        action: PlannedUnit["action"] = "import";
      const block =
        unitErrors.get(root) ??
        (dependencies.length !== dependencyRoots.length ||
        units.some((u) => dependencyRoots.includes(u.rootId) && u.action === "block")
          ? new C.T3ImportError({ reason: "ancestor-blocked" })
          : undefined);
      const countsFor = (owned: ReadonlySet<string>) => ({
        ...summary.counts,
        [PROJECTION_PREFIX + "context_transfers"]: owned.size,
        [PROJECTION_PREFIX + "turn_items"]:
          summary.counts[PROJECTION_PREFIX + "turn_items"]! + own.length,
        orchestration_v2_turn_item_positions:
          summary.counts.orchestration_v2_turn_item_positions! + own.length,
      });
      const makeMapped = (key: UnitKey, owned: ReadonlySet<string>) => {
        const nextKeys = new Map(keys);
        for (const member of own) nextKeys.set(member.id, key);
        return streamMapped(
          source.sql,
          sql,
          {
            root,
            limits,
            members: own.map((member) => member.id),
            key,
            keys: nextKeys,
            projects: projectMap,
            assets,
            ownedTransferIds: owned,
            importedAt: current.importedAt,
            unitDigest: digests.digest,
            threadDigests: digests.threadDigests,
            dependencies,
            summaries: summary.summaries,
            counts: countsFor(owned),
            ...(settings.managedPolicy?.limits?.maxRuntimeMode
              ? { maxRuntimeMode: settings.managedPolicy.limits.maxRuntimeMode }
              : {}),
          },
          () => Effect.void,
        ).pipe(
          Effect.catchDefect((cause) => Effect.fail(importError(cause))),
          Effect.mapError(importError),
        );
      };
      const oldOwnership = Effect.fn("T3Import.oldOwnership")(function* (key: UnitKey) {
        const result = new Set<string>();
        const persisted = new Set(
          Array.isArray(provenance?.ownedTransferIds) ? provenance.ownedTransferIds : [],
        );
        yield* forEachSourcePage(
          source.sql,
          own.map((member) => member.id),
          "context_transfers",
          (rows) =>
            Effect.sync(() => {
              for (const row of rows)
                if (persisted.has(destinationId(String(row.context_transfer_id), key)))
                  result.add(String(row.context_transfer_id));
            }),
          true,
        );
        return result;
      });
      if (provenance && isObject(existing)) {
        const existingKey: UnitKey = [source.environmentId, root, generation];
        if (provenance.unitDigest !== digests.digest) status = "changed-since-import";
        else {
          const oldOwned = yield* oldOwnership(existingKey);
          const mappedResult = yield* makeMapped(existingKey, oldOwned).pipe(Effect.result);
          const skeleton: PlannedUnit = {
            rootId: root,
            ownedTransferIds: oldOwned,
            exclusions: 0,
            unavailableLinks: 0,
            informationalLinks: [],
            key: existingKey,
            digest: digests.digest,
            threadDigests: digests.threadDigests,
            dependencies,
            dependencyRoots,
            status,
            action,
            members: own,
            assets,
            summary,
            counts: countsFor(oldOwned),
          };
          const complete = mappedResult._tag === "Success" && (yield* intact(skeleton, existing));
          const deletedMembers =
            yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT value FROM json_each(${encodeJson(own.filter((member) => !member.deleted).map((member) => destinationId(member.id, existingKey)))})) AND deleted_at IS NOT NULL AND json_extract(payload_json, '$.importedFrom.environmentId') = ${source.environmentId} AND json_extract(payload_json, '$.importedFrom.unitRootThreadId') = ${root} AND json_extract(payload_json, '$.importedFrom.generation') = ${generation} LIMIT 1`;
          status = !complete
            ? deletedMembers.length > 0
              ? "imported-then-deleted"
              : "copy-incomplete"
            : provenance.dependencyKey !== digest(encodeJson(dependencies))
              ? "dependency-changed"
              : "already-imported";
        }
        action = status === "imported-then-deleted" ? "import" : "skip";
        if (
          selection.newCopyUnitRootIds.includes(C.ThreadId.make(root)) &&
          status !== "already-imported"
        )
          action = "import";
      }
      const ancestorUnavailable = units.some(
        (u) =>
          dependencyRoots.includes(u.rootId) &&
          (u.action === "block" || (u.action === "skip" && u.status !== "already-imported")),
      );
      const mappingError = own
        .map((member) => projectErrors.get(member.projectId))
        .find((error) => error !== undefined);
      const cannotCreate =
        action === "import"
          ? ancestorUnavailable
            ? new C.T3ImportError({ reason: "ancestor-blocked" })
            : mappingError
          : undefined;
      if (block || unitErrors.has(root) || cannotCreate) action = "block";
      if (action === "import") generation++;
      generation = Math.max(1, generation);
      const key: UnitKey = [source.environmentId, root, generation];
      for (const member of own) keys.set(member.id, key);
      let mapped: Effect.Success<ReturnType<typeof streamMapped>> | undefined;
      let effectiveOwned = owned;
      if (action === "skip" && status === "already-imported" && provenance && isObject(existing)) {
        const oldOwned = yield* oldOwnership(key);
        effectiveOwned = oldOwned;
        mapped = yield* makeMapped(key, oldOwned);
      }
      let finalBlock = block ?? unitErrors.get(root) ?? cannotCreate;
      if (action === "import") {
        const result = yield* makeMapped(key, owned).pipe(Effect.result);
        if (result._tag === "Failure") {
          action = "block";
          finalBlock = result.failure;
        } else mapped = result.success;
      }
      informationalLinks += mapped?.informationalLinks.length ?? 0;
      if (informationalLinks > limits.informationalLinks)
        return yield* new C.T3ImportError({
          reason: "too-large",
          stage: "informational-links",
          actual: informationalLinks,
          maximum: limits.informationalLinks,
        });
      const unit: PlannedUnit = {
        rootId: root,
        ownedTransferIds: effectiveOwned,
        summary,
        counts: countsFor(effectiveOwned),
        key,
        ...digests,
        dependencies,
        dependencyRoots,
        status,
        action,
        ...(finalBlock ? { block: finalBlock } : {}),
        ...(mapped ? { expectedKeysDigest: mapped.expectedKeysDigest } : {}),
        exclusions: mapped?.exclusions ?? 0,
        unavailableLinks: mapped?.unavailableLinks ?? 0,
        informationalLinks: mapped?.informationalLinks ?? [],
        members: own,
        assets,
      };
      units.push(unit);
      for (const member of own)
        rows.threads.push({
          sourceThreadId: C.ThreadId.make(member.id),
          destinationThreadId: C.ThreadId.make(destinationId(member.id, key)),
          unitRootThreadId: C.ThreadId.make(root),
          title: member.title,
          category: action === "block" ? "blocked" : status,
          explanation: `${action}; copy ${generation}${member.deleted ? "; imported as deleted ancestor" : ""}`,
          generation,
        });
      if (action !== "import")
        rows[action === "block" ? "blocked" : "skipped"].push({
          sourceThreadId: C.ThreadId.make(root),
          unitRootThreadId: C.ThreadId.make(root),
          category: finalBlock?.reason ?? status,
          explanation:
            finalBlock?.message ??
            (status === "dependency-changed"
              ? `This copy retains its original ancestor generations: ${encodeJson(provenance?.dependencies ?? [])}. Import as a new copy to use the previewed ancestors.`
              : status === "copy-incomplete"
                ? "An expected imported row, member state or original transfer ownership is missing. Later deletion of MCP context can cause this status."
                : "Existing content is kept. Choose Import as new copy for changed or incomplete history."),
        });
      for (const dep of dependencies)
        rows.dependencies.push({
          sourceThreadId: C.ThreadId.make(root),
          unitRootThreadId: C.ThreadId.make(root),
          category: "fork-ancestor",
          explanation: `${dep.unitRootThreadId}: copy ${dep.generation}`,
          generation: dep.generation,
        });
      if (mapped?.exclusions)
        rows.exclusions.push({
          sourceThreadId: C.ThreadId.make(root),
          category: "runtime-identities-and-state",
          explanation:
            "Provider sessions, native identities, worktrees, checkpoints, delivery state and live controls are excluded.",
          count: mapped.exclusions,
        });
      if (mapped?.unavailableLinks)
        rows["unavailable-links"].push({
          sourceThreadId: C.ThreadId.make(root),
          category: "historical-links",
          explanation: "Informational links can point to threads that are unavailable.",
          count: mapped.unavailableLinks,
        });
      const ceiling = settings.managedPolicy?.limits?.maxRuntimeMode;
      if (action === "import" && ceiling) {
        const modes = yield* source.sql<{
          mode: C.RuntimeMode;
        }>`SELECT runtime_mode AS mode FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT value FROM json_each(${encodeJson(own.map((member) => member.id))}))`;
        const lowered = modes.filter((row) => C.isRuntimeModeAbove(row.mode, ceiling)).length;
        if (lowered)
          rows.warnings.push({
            sourceThreadId: C.ThreadId.make(root),
            category: "runtime-mode-lowered",
            explanation: `Runtime mode lowered to ${ceiling} by managed policy.`,
            count: lowered,
          });
      }
      for (const { asset } of assets.values())
        for (const category of [...asset.warnings, ...(asset.reason ? [asset.reason] : [])])
          rows.warnings.push({
            sourceThreadId: C.ThreadId.make(root),
            category,
            explanation:
              category === "message-path-only"
                ? "Source bytes are visible through message metadata only; the imported ID is normalized for both readers."
                : category === "legacy-asset-normalized"
                  ? "The destination ID includes the actual staged filename extension."
                  : "No placeholder bytes will be created for this unavailable asset.",
            count: 1,
          });
    }
    for (const mapping of mappings)
      rows.mappings.push({
        category: mapping.create ? "create-project" : "existing-project",
        explanation: `${mapping.source} → ${mapping.destination}; ${mapping.title}; ${mapping.workspaceRoot}`,
      });
    rows.exclusions.push({
      category: "import-boundaries",
      explanation:
        "Schedules, secrets, credentials, links, sharing, launch workflows, pending work and checkpoints are not imported. New projects receive only title and workspace root. Old histories can be marked settled by the normal settlement sweep.",
    });
    rows.warnings.push({
      category: "separate-snapshots",
      explanation:
        "History is frozen in a read-only database snapshot. Asset bytes are frozen separately during preview. Provider continuation uses a bounded summary; full history remains visible.",
    });
    for (const [section, values] of Object.entries(rows))
      for (let index = 0; index < values.length; index++)
        values[index] = {
          ...values[index]!,
          id: digest(encodeJson([section, index, values[index]])),
        };
    const totals = {
      threads: members.size + skippedMembers.length,
      units: rootMembers.size,
      importing: units
        .filter((u) => u.action === "import")
        .reduce((n, u) => n + u.members.length, 0),
      blocked: rows.blocked.length,
      skipped: rows.skipped.length,
      assets: [...assetsByRoot.values()].reduce((n, a) => n + a.size, 0),
      assetBytes: jobAssetBytes,
      ...recordTotals,
    };
    const id = C.T3ImportPlanId.make(
      digest(
        encodeJson([
          current.id,
          selection,
          mappings,
          units.map((u) => [
            u.key,
            u.digest,
            u.dependencies,
            u.status,
            u.action,
            u.block?.reason,
            u.expectedKeysDigest ?? null,
          ]),
          rows,
        ]),
      ),
    );
    const sections = Object.fromEntries(
      Object.entries(rows).map(([section, values]) => [
        section,
        { ...pageRows(values), count: values.length },
      ]),
    ) as C.T3ImportPreview["sections"];
    return {
      id,
      sessionId: current.id,
      selection,
      units,
      projects: mappings,
      blockedMembers,
      skippedMembers,
      rows,
      preview: { planId: id, totals, sections },
    } satisfies Plan;
  }, Effect.mapError(importError));

  const commitUnit = Effect.fn("T3ImportService.commitUnit")(function* (
    current: Job,
    unit: PlannedUnit,
  ) {
    yield* ensureAdmission();
    const keys = new Map(
      current.plan.units.flatMap((candidate) =>
        candidate.members.map((member) => [member.id, candidate.key] as const),
      ),
    );
    const stage = yield* buildMappedUnit(
      session!.source!.sql,
      sql,
      session!.directory,
      {
        root: unit.rootId,
        checkCancelled: Effect.suspend(() =>
          current.cancelled
            ? Effect.fail(new C.T3ImportError({ reason: "cancelled" }))
            : Effect.void,
        ),
        limits,
        members: unit.members.map((member) => member.id),
        key: unit.key,
        keys,
        projects: new Map(
          current.plan.projects.map((project) => [project.source, project.destination]),
        ),
        assets: unit.assets,
        ownedTransferIds: unit.ownedTransferIds,
        importedAt: session!.importedAt,
        unitDigest: unit.digest,
        threadDigests: unit.threadDigests,
        dependencies: unit.dependencies,
        summaries: unit.summary.summaries,
        counts: unit.counts,
        ...(settings.managedPolicy?.limits?.maxRuntimeMode
          ? { maxRuntimeMode: settings.managedPolicy.limits.maxRuntimeMode }
          : {}),
      },
      (privateSql) =>
        Effect.gen(function* () {
          for (const root of unit.dependencyRoots) {
            const dependency = current.plan.units.find((candidate) => candidate.rootId === root)!;
            yield* visitExpected(dependency, (table, keys) =>
              privateSql`INSERT INTO t3i_dependency_keys SELECT ${root},${table},json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${encodeJson(keys)})`.pipe(
                Effect.asVoid,
              ),
            );
            for (const id of dependency.ownedTransferIds)
              yield* privateSql`INSERT INTO t3i_dep_transfer_candidates VALUES (${root},${destinationId(id, dependency.key)})`;
          }
        }),
    ).pipe(
      Effect.catchDefect((cause) => Effect.fail(importError(cause))),
      Effect.mapError(importError),
    );
    let attachmentAttempted = false;
    const stageDirectory = session!.directory;
    const detach = Effect.gen(function* () {
      if (!attachmentAttempted) return true;
      yield* milestone("before-detach", unit.rootId);
      const result = yield* sql.unsafe("DETACH DATABASE t3i_unit").unprepared.pipe(Effect.result);
      if (result._tag === "Failure") {
        const cause = result.failure.reason.cause;
        if (!(cause instanceof Error && /no such database/i.test(cause.message))) return false;
      }
      const aliases = yield* sql.unsafe(
        "SELECT 1 FROM pragma_database_list WHERE name = 't3i_unit'",
      ).unprepared;
      return aliases.length === 0;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));
    const cleanup = Effect.uninterruptible(
      Effect.gen(function* () {
        if (yield* detach) {
          yield* stage.dispose;
          return;
        }
        yield* Effect.logWarning("T3 import staging cleanup remains blocked");
        pinnedDirectories.add(stageDirectory);
        const lease = admission;
        const dispose = stage.dispose.pipe(
          Effect.andThen(
            Effect.sync(() => {
              lease?.db.close();
              pinnedDirectories.delete(stageDirectory);
            }),
          ),
          Effect.andThen(
            Effect.suspend(() =>
              importerClosed || session?.directory !== stageDirectory
                ? io(() => NodeFSP.rm(stageDirectory, { recursive: true, force: true })).pipe(
                    Effect.orDie,
                  )
                : Effect.void,
            ),
          ),
        );
        if (
          !lifetime?.retain({
            tryRelease: detach.pipe(
              Effect.flatMap((released) =>
                released ? Effect.as(dispose, true) : Effect.succeed(false),
              ),
            ),
            disposeAfterClose: dispose,
          })
        )
          return yield* Effect.die(
            new C.T3ImportError({ reason: "busy", stage: "cleanup-blocked" }),
          );
        admission = undefined;
        initialized = false;
      }),
    );
    const commit = Effect.gen(function* () {
      yield* milestone("after-unit-staging", unit.rootId);
      if (current.cancelled) return yield* new C.T3ImportError({ reason: "cancelled" });
      yield* io(stage.verify);
      const publishBytes = stage.mapped.assets.reduce(
        (bytes, asset) => bytes + asset.bytes + (asset.sidecar?.bytes ?? 0),
        0,
      );
      const publishSpace = yield* io(() => NodeFSP.statfs(config.stateDir));
      if (publishSpace.bavail * publishSpace.bsize < publishBytes + 64 * 1024 ** 2)
        return yield* new C.T3ImportError({ reason: "insufficient-space", stage: "publication" });
      const destinationSpace = yield* io(() => NodeFSP.statfs(NodePath.dirname(config.dbPath)));
      if (destinationSpace.bavail * destinationSpace.bsize < stage.size * 5 + 64 * 1024 ** 2)
        return yield* new C.T3ImportError({ reason: "insufficient-space", stage: "destination" });

      yield* reconcile(unit.key);
      if ((yield* outcome(unit.key)) === "committed") return "skipped" as const;
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const publication = yield* io(() =>
            Publisher.beginPublication(paths, unit.key, current.id, stage.mapped.assets),
          );
          const work = Effect.gen(function* () {
            yield* io(() => Publisher.publishFiles(paths, publication));
            yield* milestone("assets-published", unit.rootId);
            if (current.cancelled) return yield* new C.T3ImportError({ reason: "cancelled" });
            yield* milestone("before-commit", unit.rootId);
            yield* io(stage.verify);
            yield* sink.withProviderBatch(
              Effect.gen(function* () {
                yield* verifyAdmission();
                attachmentAttempted = true;
                yield* sql.unsafe("ATTACH DATABASE ? AS t3i_unit", [
                  NodeURL.pathToFileURL(stage.filename).href + "?mode=ro",
                ]).unprepared;
                const seal = yield* sql.unsafe<{ nonce: string }>(
                  "SELECT nonce FROM t3i_unit.t3i_seal",
                ).unprepared;
                const pages = yield* sql.unsafe<{ page_count: number }>(
                  "PRAGMA t3i_unit.page_count",
                ).unprepared;
                const size = yield* sql.unsafe<{ page_size: number }>("PRAGMA t3i_unit.page_size")
                  .unprepared;
                yield* io(stage.verifyIdentity);
                if (
                  seal[0]?.nonce !== stage.nonce ||
                  Number(pages[0]?.page_count) * Number(size[0]?.page_size) !== stage.size
                )
                  return yield* new C.T3ImportError({
                    reason: "staging-failed",
                    stage: "private-binding",
                  });
                for (const dependencyRoot of unit.dependencyRoots) {
                  const dependency = current.plan.units.find((u) => u.rootId === dependencyRoot);
                  if (
                    !dependency ||
                    (!dependency.expectedKeysDigest && dependency.action !== "skip")
                  )
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: "ancestor",
                    });
                  const rows = yield* sql<{
                    readonly payload_json: string;
                  }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${destinationId(dependencyRoot, dependency.key)}`;
                  if (!rows[0])
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: "ancestor-absent",
                    });
                  const existing: unknown = yield* attempt(() => JSON.parse(rows[0]!.payload_json));
                  if (
                    !isObject(existing) ||
                    !isObject(existing.importedFrom) ||
                    existing.importedFrom.unitDigest !== dependency.digest ||
                    existing.importedFrom.dependencyKey !==
                      digest(encodeJson(dependency.dependencies))
                  )
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: "ancestor-content",
                    });
                  if (!(yield* intact(dependency, existing, true)))
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: "ancestor-incomplete",
                    });
                }
                for (const project of current.plan.projects.filter((p) =>
                  unit.members.some((m) => m.projectId === p.source),
                )) {
                  const rows = yield* sql<{
                    readonly workspace_root: string;
                    readonly deleted_at: string | null;
                  }>`SELECT workspace_root, deleted_at FROM projection_projects WHERE project_id = ${project.destination}`;
                  if (!rows[0] && project.create)
                    yield* projects.create({
                      commandId: C.CommandId.make(
                        destinationId("project-create:" + project.destination, [
                          unit.key[0],
                          "project:" + project.source,
                          1,
                        ]),
                      ),
                      projectId: project.destination,
                      title: project.title,
                      workspaceRoot: project.workspaceRoot,
                    });
                  else if (
                    !rows[0] ||
                    rows[0].deleted_at !== null ||
                    normalizedRoot(rows[0].workspace_root) !== project.workspaceRoot
                  )
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: "project",
                    });
                }
                const hits =
                  yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT value FROM json_each(${encodeJson(unit.members.map((member) => destinationId(member.id, unit.key)))})) LIMIT 1`;
                if (hits.length)
                  return yield* new C.T3ImportError({
                    reason: "destination-conflict",
                    stage: "threads",
                  });
                const created = stage.created;
                const maxMode = settings.managedPolicy?.limits?.maxRuntimeMode;
                if (maxMode && runtimeModeCeilingRefusal(maxMode, created, new Map()) !== undefined)
                  return yield* new C.T3ImportError({ reason: "policy-refused" });
                yield* sink.write({ events: created });
                for (const table of stage.tables) {
                  if (table.name === PROJECTION_PREFIX + "threads") continue;
                  const name = quoteIdentifier(table.name);
                  const columns = table.columns.map(quoteIdentifier).join(",");
                  let cursor = 0;
                  for (;;) {
                    const batch = yield* sql.unsafe<{ last: number; count: number }>(
                      `SELECT MAX(rowid) AS last,COUNT(*) AS count FROM (SELECT rowid,__bytes,SUM(__bytes) OVER (ORDER BY rowid) AS cumulative,ROW_NUMBER() OVER (ORDER BY rowid) AS rn FROM (SELECT rowid,${rowBytesSql(table.columns)} AS __bytes FROM t3i_unit.${name} WHERE rowid > ? ORDER BY rowid LIMIT 5000)) WHERE cumulative <= 33554432 OR rn = 1`,
                      [cursor],
                    ).unprepared;
                    if (!batch[0]?.count) break;
                    yield* sql
                      .unsafe(
                        `INSERT INTO main.${name} (${columns}) SELECT ${columns} FROM t3i_unit.${name} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
                        [cursor, batch[0].last],
                      )
                      .unprepared.pipe(
                        Effect.mapError(
                          (cause) =>
                            new C.T3ImportError({
                              reason: "destination-conflict",
                              stage: table.name,
                              cause,
                            }),
                        ),
                      );
                    const changes = yield* sql.unsafe<{ count: number }>(
                      "SELECT changes() AS count",
                    ).unprepared;
                    if (changes[0]?.count !== batch[0].count)
                      return yield* new C.T3ImportError({
                        reason: "staging-failed",
                        stage: "copy-count",
                      });
                    cursor = batch[0].last;
                    yield* milestone("mid-bulk", unit.rootId);
                  }
                }
                const ids = unit.members.map((member) =>
                  C.ThreadId.make(destinationId(member.id, unit.key)),
                );
                yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = ${session!.importedAt},payload_json = json_set(payload_json,'$.updatedAt',${session!.importedAt}) WHERE thread_id IN (SELECT value FROM json_each(${encodeJson(ids)}))`;
                const groups = yield* sql.unsafe<{ grp: string }>(
                  "SELECT DISTINCT grp FROM t3i_unit.t3i_structural_refs",
                ).unprepared;
                for (const group of groups) {
                  const [table, columns] = yield* attempt(
                    () => JSON.parse(group.grp) as [string, string[]],
                  );
                  const missing = yield* sql.unsafe(
                    `SELECT 1 FROM t3i_unit.t3i_structural_refs expected WHERE grp = ? AND NOT EXISTS (SELECT 1 FROM main.${quoteIdentifier(table)} target WHERE ${columns.map((column, index) => `target.${quoteIdentifier(column)} = expected.c${index + 1}`).join(" AND ")}) LIMIT 1`,
                    [group.grp],
                  ).unprepared;
                  if (missing.length)
                    return yield* new C.T3ImportError({
                      reason: "dependency-changed",
                      stage: table,
                    });
                }
                yield* milestone("before-gate", unit.rootId);
                for (const now of [
                  yield* DateTime.now,
                  DateTime.makeUnsafe("9999-12-31T00:00:00Z"),
                ]) {
                  const candidates = yield* projections.findWorkCandidates(ids, { now });
                  if (candidates.length)
                    return yield* new C.T3ImportError({
                      reason: "would-start-work",
                      stage: candidates[0]!.kind,
                    });
                }
              }),
            );
            yield* milestone("after-commit", unit.rootId);
          });
          const result = yield* Effect.exit(restore(work.pipe(Effect.mapError(importError))));
          const resolved = yield* outcome(unit.key).pipe(
            Effect.orElseSucceed(() => "unknown" as const),
          );
          yield* io(() => Publisher.finishPublication(paths, publication.entry, resolved));
          if (resolved === "committed") return "imported" as const;
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return yield* new C.T3ImportError({ reason: "unknown", stage: "missing-commit" });
        }),
      );
    });
    return yield* commit.pipe(Effect.ensuring(cleanup));
  }, Effect.mapError(importError));

  const runJob = Effect.fn("T3ImportService.runJob")(function* (current: Job) {
    const failed = new Set<string>();
    for (const member of current.plan.skippedMembers)
      current.results.push({
        sourceThreadId: C.ThreadId.make(member.id),
        outcome: "skipped",
        reason: "empty-side-chat",
        unavailableLinks: 0,
      });
    for (const { member, error } of current.plan.blockedMembers)
      current.results.push({
        sourceThreadId: C.ThreadId.make(member.id),
        outcome: "blocked",
        reason: error.reason,
        unavailableLinks: 0,
      });
    for (const unit of current.plan.units) {
      let outcome: C.T3ImportResult["outcome"], reason: string;
      if (current.cancelled || current.status === "unknown") {
        outcome = "not-started";
        reason = current.status === "unknown" ? "unknown-prior-outcome" : "cancelled";
      } else if (unit.dependencyRoots.some((r) => failed.has(r))) {
        outcome = "dependency-failed";
        reason = "ancestor-failed";
      } else if (unit.action === "block") {
        outcome = "blocked";
        reason = unit.block?.reason ?? "blocked";
      } else if (unit.action === "skip") {
        outcome = "skipped";
        reason = unit.status;
      } else {
        const result = yield* lock.withPermits(1)(commitUnit(current, unit)).pipe(Effect.result);
        if (result._tag === "Success") {
          outcome = result.success;
          reason = result.success;
        } else {
          outcome = result.failure.reason === "cancelled" ? "not-started" : "failed";
          reason = result.failure.reason;
          if (reason === "unknown") current.status = "unknown";
        }
      }
      if (outcome !== "imported" && !(outcome === "skipped" && unit.status === "already-imported"))
        failed.add(unit.rootId);
      for (const member of unit.members)
        current.results.push({
          sourceThreadId: C.ThreadId.make(member.id),
          destinationThreadId: C.ThreadId.make(destinationId(member.id, unit.key)),
          outcome,
          reason,
          unavailableLinks: unit.unavailableLinks,
        });
    }
    const links = current.plan.units
      .flatMap((unit) => unit.informationalLinks)
      .filter((link) =>
        current.results.some(
          (result) => result.sourceThreadId === link.sourceOwner && result.outcome === "imported",
        ),
      );
    const targetIds = [...new Set(links.map((link) => link.destinationThreadId))],
      available = new Set<string>();
    for (let offset = 0; offset < targetIds.length; offset += 500) {
      const rows = yield* sql<{
        readonly thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND thread_id IN (SELECT value FROM json_each(${encodeJson(targetIds.slice(offset, offset + 500))}))`;
      for (const row of rows) available.add(row.thread_id);
    }
    for (let index = 0; index < current.results.length; index++) {
      const result = current.results[index]!;
      if (result.outcome === "imported")
        current.results[index] = {
          ...result,
          unavailableLinks: links
            .filter(
              (link) =>
                link.sourceOwner === result.sourceThreadId &&
                !available.has(link.destinationThreadId),
            )
            .reduce((n, link) => n + link.count, 0),
        };
    }
    for (const link of links)
      if (!available.has(link.destinationThreadId))
        current.unavailableLinkRows.push({
          sourceThreadId: C.ThreadId.make(link.sourceOwner),
          destinationThreadId: C.ThreadId.make(link.destinationThreadId),
          unitRootThreadId: C.ThreadId.make(link.targetUnitRootId),
          category: "informational-target-unavailable",
          explanation:
            "This historical link names a thread whose copy is unavailable. It does not prevent this history from being imported.",
          count: link.count,
        });
    if (current.status !== "unknown")
      current.status = current.cancelled ? "cancelled" : "completed";
    if (session) session.touchedAt = yield* Clock.currentTimeMillis;
  });

  const open: Methods["open"] = Effect.fn("T3ImportService.open")(function* (input) {
    if (running()) return yield* new C.T3ImportError({ reason: "busy" });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (running()) return yield* new C.T3ImportError({ reason: "busy" });
        yield* ensureAdmission(true);
        if (journalBlocked)
          return yield* new C.T3ImportError({ reason: "unknown", stage: "startup-journal" });
        if (session) {
          yield* disposeSession(session);
        }
        const id = C.T3ImportSessionId.make(NodeCrypto.randomUUID());
        const current: Session = {
          id,
          scope: yield* Scope.make(),
          directory: NodePath.join(config.stateDir, "imports", "t3", "sessions", id),
          ready: yield* Deferred.make<T3ImportStaging.StagedSource, C.T3ImportError>(),
          closed: yield* Deferred.make<void>(),
          status: "preparing",
          importedAt: DateTime.formatIso(yield* DateTime.now),
          touchedAt: yield* Clock.currentTimeMillis,
          assets: new Map(),
        };
        session = current;
        job = undefined;
        yield* Effect.raceFirst(Deferred.await(current.closed), expireSession(current)).pipe(
          Effect.forkIn(scope),
        );
        const sourceHome = normalizedRoot(
          input.sourceHome ?? NodePath.join(NodeOS.homedir(), ".t3"),
        );
        yield* staging
          .open({
            sourceHome,
            directory: current.directory,
            destinationDb: config.dbPath,
            destinationEnvironmentId: environmentId,
          })
          .pipe(
            Effect.provideService(Scope.Scope, current.scope),
            Effect.tap((source) =>
              Effect.sync(() => {
                current.source = source;
                current.status = "ready";
              }),
            ),
            Effect.tap((source) => Deferred.succeed(current.ready, source)),
            Effect.catch((error) =>
              Effect.gen(function* () {
                current.error = error;
                current.status = "failed";
                yield* Deferred.fail(current.ready, error);
              }),
            ),
            Effect.forkIn(current.scope),
          );
        return { sessionId: id };
      }),
    );
  });
  const getSession: Methods["getSession"] = Effect.fn("T3ImportService.getSession")(function* (
    input,
  ) {
    if (!input.sessionId && !session)
      return yield* new C.T3ImportError({ reason: "session-not-found" });
    const current = yield* requireSession(input.sessionId ?? session!.id);
    const source = current.source;
    if (!source)
      return {
        sessionId: current.id,
        status: current.status,
        projects: [],
        nextProjectCursor: null,
        ...(current.error ? { error: C.T3ImportError.forClient(current.error) } : {}),
      };
    const projects = yield* source.sql<{
      readonly project_id: string;
      readonly title: string;
      readonly workspace_root: string;
      readonly count: number;
    }>`SELECT p.project_id, p.title, p.workspace_root, (SELECT COUNT(*) FROM orchestration_v2_projection_threads t WHERE t.project_id = p.project_id AND t.deleted_at IS NULL AND CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent' AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1 ELSE 1 END) AS count FROM projection_projects p WHERE p.deleted_at IS NULL AND p.project_id > ${input.projectCursor ?? ""} ORDER BY p.project_id LIMIT 101`;
    return {
      sessionId: current.id,
      status: current.status,
      source: {
        home: source.home,
        environmentId: source.environmentId,
        schemaHead: source.schemaHead,
      },
      projects: projects.slice(0, 100).map((p) => ({
        id: C.ProjectId.make(p.project_id),
        title: p.title,
        workspaceRoot: p.workspace_root,
        threadCount: p.count,
      })),
      nextProjectCursor: projects.length > 100 ? projects[99]!.project_id : null,
    };
  }, Effect.mapError(importError));
  const listThreads: Methods["listThreads"] = Effect.fn("T3ImportService.listThreads")(function* (
    input,
  ) {
    const { source } = yield* requireReady(input.sessionId);
    const rows = yield* source.sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly title: string;
      readonly archived_at: string | null;
      readonly items: number;
      readonly runs: number;
    }>`SELECT t.thread_id, t.project_id, t.title, t.archived_at, (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items i WHERE i.thread_id = t.thread_id) AS items, (SELECT COUNT(*) FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id) AS runs FROM orchestration_v2_projection_threads t WHERE t.project_id = ${input.sourceProjectId} AND t.thread_id > ${input.cursor ?? ""} AND t.deleted_at IS NULL AND CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent' AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1 ELSE 1 END AND instr(lower(t.title), lower(${input.query ?? ""})) > 0 ORDER BY t.thread_id LIMIT 101`;
    return {
      threads: rows.slice(0, 100).map((r) => ({
        id: C.ThreadId.make(r.thread_id),
        projectId: C.ProjectId.make(r.project_id),
        title: r.title,
        archived: r.archived_at !== null,
        itemCount: r.items,
        runCount: r.runs,
      })),
      nextCursor: rows.length > 100 ? rows[99]!.thread_id : null,
    };
  }, Effect.mapError(importError));
  const preview: Methods["preview"] = Effect.fn("T3ImportService.preview")(function* (input) {
    if (running()) return yield* new C.T3ImportError({ reason: "busy" });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (running()) return yield* new C.T3ImportError({ reason: "busy" });
        const { session: current, source } = yield* requireReady(input.sessionId);
        const plan = yield* buildPlan(current, source, input.selection);
        current.plan = plan;
        return plan.preview;
      }),
    );
  });
  const previewPage: Methods["previewPage"] = Effect.fn("T3ImportService.previewPage")(
    function* (input) {
      yield* ensureAdmission();
      if (!session?.plan || session.plan.id !== input.planId)
        return yield* new C.T3ImportError({ reason: "plan-changed" });
      session.touchedAt = yield* Clock.currentTimeMillis;
      return yield* attempt(() => pageRows(session!.plan!.rows[input.section], input.cursor));
    },
  );
  const start: Methods["start"] = Effect.fn("T3ImportService.start")(function* (input) {
    if (running()) return yield* new C.T3ImportError({ reason: "busy" });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (running()) return yield* new C.T3ImportError({ reason: "busy" });
        const { session: current, source } = yield* requireReady(input.sessionId);
        if (current.plan?.id !== input.planId)
          return yield* new C.T3ImportError({ reason: "plan-changed" });
        // Reconcile prior outcomes before repeating any asset absence check or creating a new journal.
        for (const unit of current.plan.units) yield* reconcile(unit.key);
        const plan = yield* buildPlan(current, source, current.plan.selection);
        if (plan.id !== input.planId) return yield* new C.T3ImportError({ reason: "plan-changed" });
        const next: Job = {
          id: C.T3ImportJobId.make(NodeCrypto.randomUUID()),
          plan,
          done: yield* Deferred.make<void, C.T3ImportError>(),
          status: "running",
          cancelled: false,
          results: [],
          unavailableLinkRows: [],
        };
        job = next;
        yield* runJob(next).pipe(
          Effect.tap(() => Deferred.succeed(next.done, undefined)),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              next.status = "unknown";
              const completed = new Set(next.results.map((result) => result.sourceThreadId));
              for (const member of [
                ...next.plan.units.flatMap((unit) => unit.members),
                ...next.plan.blockedMembers.map((entry) => entry.member),
                ...next.plan.skippedMembers,
              ])
                if (!completed.has(C.ThreadId.make(member.id)))
                  next.results.push({
                    sourceThreadId: C.ThreadId.make(member.id),
                    outcome: "not-started",
                    reason: "unknown-prior-outcome",
                    unavailableLinks: 0,
                  });
              yield* Deferred.fail(next.done, importError(Cause.squash(cause)));
            }),
          ),
          Effect.forkIn(scope),
        );
        return { jobId: next.id };
      }),
    );
  });
  const getJob: Methods["getJob"] = Effect.fn("T3ImportService.getJob")(function* (input) {
    if (!job) yield* ensureAdmission();
    if (!job || (input.jobId !== undefined && job.id !== input.jobId))
      return yield* new C.T3ImportError({ reason: "job-not-found" });
    if (session?.id === job.plan.sessionId) session.touchedAt = yield* Clock.currentTimeMillis;
    const cursor = /^(\d+)(?::(\d+))?$/.exec(input.cursor ?? "0");
    const offset = Number(cursor?.[1]),
      linkOffset = Number(cursor?.[2] ?? 0);
    if (
      !cursor ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(linkOffset) ||
      linkOffset < 0
    )
      return yield* new C.T3ImportError({ reason: "job-not-found", stage: "cursor" });
    return {
      jobId: job.id,
      status: job.status,
      progress: { completed: job.results.length, total: job.plan.preview.totals.threads ?? 0 },
      results: job.results.slice(offset, offset + 100),
      unavailableLinkRows: job.unavailableLinkRows.slice(linkOffset, linkOffset + 100),
      nextCursor:
        offset + 100 < job.results.length || linkOffset + 100 < job.unavailableLinkRows.length
          ? `${offset + 100}:${linkOffset + 100}`
          : null,
    };
  });
  const cancel: Methods["cancel"] = Effect.fn("T3ImportService.cancel")(function* (input) {
    yield* ensureAdmission();
    if (!job || job.id !== input.jobId)
      return yield* new C.T3ImportError({ reason: "job-not-found" });
    if (running()) {
      job.cancelled = true;
      job.status = "cancelling";
    }
    return { status: job.status };
  });
  const close: Methods["close"] = Effect.fn("T3ImportService.close")(function* (input) {
    if (running()) return yield* new C.T3ImportError({ reason: "busy" });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (running()) return yield* new C.T3ImportError({ reason: "busy" });
        const current = yield* requireSession(input.sessionId);
        yield* disposeSession(current);
        session = undefined;
        job = undefined;
        return {};
      }),
    );
  });
  return T3ImportService.of({
    open,
    getSession,
    listThreads,
    preview,
    previewPage,
    start,
    getJob,
    cancel,
    close,
    awaitReady: Effect.fn("T3ImportService.awaitReady")(function* (id) {
      const current = yield* requireSession(id);
      yield* Deferred.await(current.ready);
    }),
    awaitJob: Effect.fn("T3ImportService.awaitJob")(function* (id) {
      if (!job || job.id !== id) return yield* new C.T3ImportError({ reason: "job-not-found" });
      yield* Deferred.await(job.done);
    }),
  });
});

export const layer = Layer.effect(T3ImportService, make);
