// @effect-diagnostics nodeBuiltinImport:off
// Descriptor anchoring, hard links and inode witnesses require Node filesystem primitives.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EnvironmentId, T3ImportError } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { openSourceAnchors, isAbsent, type SourceAnchors } from "./t3ImportAssets.ts";
import { ImportLimits, SNAPSHOT_TABLES, quoteIdentifier, rowBytesSql } from "./t3ImportPlan.ts";

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
  readonly hidden: number;
}
export interface StagedSource {
  readonly sql: SqlClient.SqlClient;
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly environmentId: EnvironmentId;
  readonly schemaHead: number;
  readonly directory: string;
  readonly home: string;
  readonly anchors: SourceAnchors;
}
export class T3ImportStaging extends Context.Service<
  T3ImportStaging,
  {
    readonly open: (input: {
      readonly sourceHome: string;
      readonly directory: string;
      readonly destinationDb: string;
      readonly destinationEnvironmentId: EnvironmentId;
    }) => Effect.Effect<StagedSource, T3ImportError, Scope.Scope>;
  }
>()("t3/u4/t3Import/T3ImportStaging") {}

export const StagingHooks = Context.Reference<{
  readonly snapshotRead?: (sql: SqlClient.SqlClient) => Effect.Effect<void, T3ImportError>;
  readonly anchorHooks?: Parameters<typeof openSourceAnchors>[1];
}>("t3/u4/t3Import/T3ImportStaging/Hooks", { defaultValue: () => ({}) });

const isImportError = Schema.is(T3ImportError);
const sourceError = (cause: unknown) =>
  isImportError(cause)
    ? cause
    : new T3ImportError({ reason: "staging-failed", stage: "snapshot", cause });
const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: sourceError });

const prepare = Effect.fn("T3ImportStaging.prepare")(function* (
  input: Parameters<T3ImportStaging["Service"]["open"]>[0],
) {
  const limits = yield* ImportLimits;
  const hooks = yield* StagingHooks;
  const platform = yield* HostProcess.Platform;
  const home = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(input.sourceHome),
    catch: (cause) => new T3ImportError({ reason: "source-not-found", cause }),
  });
  const anchors = yield* Effect.acquireRelease(
    io(() => openSourceAnchors(home, hooks.anchorHooks, platform)),
    (anchors) => Effect.promise(anchors.close).pipe(Effect.orDie),
  );
  const sourcePath = `/proc/self/fd/${anchors.userdata.fd}/statev2.sqlite`;
  const sourceFile = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(sourcePath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW),
      catch: (cause) =>
        isAbsent(cause)
          ? new T3ImportError({ reason: "no-v2-database", cause })
          : sourceError(cause),
    }),
    (file) => Effect.promise(() => file.close()),
  );
  const sourceStat = yield* io(() => sourceFile.stat());
  if (!sourceStat.isFile()) return yield* new T3ImportError({ reason: "no-v2-database" });
  const destinationStat = yield* io(async () => {
    try {
      return await NodeFSP.stat(input.destinationDb);
    } catch {
      return null;
    }
  });
  if (
    destinationStat &&
    destinationStat.dev === sourceStat.dev &&
    destinationStat.ino === sourceStat.ino
  )
    return yield* new T3ImportError({ reason: "same-environment" });
  const environmentFile = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.open(
          `/proc/self/fd/${anchors.userdata.fd}/environment-id`,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
        ),
      catch: (cause) => new T3ImportError({ reason: "no-environment-id", cause }),
    }),
    (file) => Effect.promise(() => file.close()),
  );
  const environmentStat = yield* io(() => environmentFile.stat());
  if (!environmentStat.isFile() || environmentStat.size > 256)
    return yield* new T3ImportError({ reason: "no-environment-id" });
  const rawEnvironment = (yield* io(() => environmentFile.readFile("utf8"))).trim();
  if (!rawEnvironment) return yield* new T3ImportError({ reason: "no-environment-id" });
  const environmentId = EnvironmentId.make(rawEnvironment);
  if (environmentId === input.destinationEnvironmentId)
    return yield* new T3ImportError({ reason: "same-environment" });
  yield* io(() => NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 }));
  const filename = NodePath.join(input.directory, "snapshot.sqlite");
  const exclusive = yield* io(() => NodeFSP.open(filename, "wx", 0o600));
  yield* io(() => exclusive.close());
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename, writerWorker: true }));
  const sql = Context.get(context, SqlClient.SqlClient);
  const staging = Effect.gen(function* () {
    yield* sql`PRAGMA trusted_schema = OFF`;
    const uri = NodeURL.pathToFileURL(sourcePath).href + "?mode=ro";
    yield* sql`ATTACH DATABASE ${uri} AS src`;
    const validate = Effect.fn("T3ImportStaging.validate")(function* (
      table: string,
      columns: ReadonlyArray<Column>,
    ) {
      const objects = yield* sql<{
        readonly type: string;
        readonly sql: string;
      }>`SELECT type, sql FROM src.sqlite_master WHERE name = ${table}`;
      const object = objects[0];
      const types = yield* sql<{
        readonly type: string;
      }>`SELECT type FROM pragma_table_list WHERE schema = 'src' AND name = ${table}`;
      if (
        objects.length !== 1 ||
        object?.type !== "table" ||
        !/^CREATE\s+TABLE\b/i.test(object.sql ?? "") ||
        types[0]?.type !== "table"
      )
        return yield* new T3ImportError({ reason: "divergent-schema", stage: table });
      const actual =
        yield* sql<Column>`SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(${table}, 'src')`;
      for (const expected of columns) {
        const got = actual.find((column) => column.name === expected.name);
        if (
          !got ||
          got.hidden !== 0 ||
          got.type.toUpperCase() !== expected.type.toUpperCase() ||
          got.notnull !== expected.notnull ||
          got.pk !== expected.pk
        )
          return yield* new T3ImportError({
            reason: "divergent-schema",
            stage: `${table}.${expected.name}`,
          });
      }
    });
    const ledgerColumns: Column[] = [
      { name: "migration_id", type: "INTEGER", notnull: 1, pk: 1, hidden: 0 },
      { name: "name", type: "VARCHAR(255)", notnull: 1, pk: 0, hidden: 0 },
    ];
    const readHead = Effect.gen(function* () {
      yield* validate("effect_sql_migrations", ledgerColumns);
      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM src.effect_sql_migrations ORDER BY migration_id`;
      const head = rows.at(-1)?.migration_id ?? 0;
      if (head > migrationManifest.at(-1)![0])
        return yield* new T3ImportError({ reason: "newer-schema" });
      if (head < 81) return yield* new T3ImportError({ reason: "older-schema" });
      if (
        rows.length !== head ||
        rows.some(
          (row, i) =>
            row.migration_id !== migrationManifest[i]?.[0] ||
            row.name !== migrationManifest[i]?.[1],
        )
      )
        return yield* new T3ImportError({ reason: "divergent-ledger" });
      return head;
    });
    const head = yield* sql.withTransaction(readHead);
    yield* runMigrations({ toMigrationInclusive: head });
    const columns = new Map<string, ReadonlyArray<Column>>();
    for (const table of SNAPSHOT_TABLES) {
      columns.set(
        table,
        yield* sql<Column>`SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(${table}) WHERE hidden = 0`,
      );
    }
    yield* sql`CREATE TABLE t3_import_oversized (table_name TEXT NOT NULL, thread_id TEXT, row_bytes INTEGER NOT NULL)`;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* readHead) !== head)
          return yield* new T3ImportError({ reason: "source-changed", stage: "ledger" });
        if (hooks.snapshotRead) yield* hooks.snapshotRead(sql);
        for (const [table, required] of columns) yield* validate(table, required);
        for (const [table, names] of [
          ["projection_threads", ["thread_id"]],
          [
            "orchestration_events",
            ["application_event_version", "aggregate_kind", "stream_id", "event_type"],
          ],
        ] as const) {
          const trusted =
            yield* sql<Column>`SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(${table})`;
          yield* validate(
            table,
            trusted.filter((column) => (names as ReadonlyArray<string>).includes(column.name)),
          );
        }
        const pending = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM (
        SELECT thread.thread_id FROM src.projection_threads thread WHERE NOT EXISTS (
          SELECT 1 FROM src.orchestration_events event WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread' AND event.stream_id = thread.thread_id AND event.event_type = 'thread.created'
        ) UNION SELECT thread_id FROM src.orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL
      )`;
        if ((pending[0]?.count ?? 0) > 0)
          return yield* new T3ImportError({ reason: "pending-v1-threads" });
        let bytes = 0;
        for (const [table, trusted] of columns) {
          const rowBytes = rowBytesSql(trusted.map((column) => column.name));
          const totals = yield* sql.unsafe<{ readonly bytes: number }>(
            `SELECT COALESCE(SUM(${rowBytes}), 0) AS bytes FROM src.${quoteIdentifier(table)}`,
          );
          bytes += totals[0]?.bytes ?? NaN;
        }
        if (!Number.isSafeInteger(bytes) || bytes > limits.snapshotBytes)
          return yield* new T3ImportError({
            reason: "too-large",
            stage: "snapshotBytes",
            actual: Number.isSafeInteger(bytes) ? bytes : limits.snapshotBytes + 1,
            maximum: limits.snapshotBytes,
          });
        const space = yield* io(() => NodeFSP.statfs(input.directory));
        if (space.bavail * space.bsize < bytes * 5 + 64 * 1024 ** 2)
          return yield* new T3ImportError({ reason: "insufficient-space", stage: "snapshot" });
        for (const [table, trusted] of columns) {
          const names = trusted.map((column) => column.name);
          const list = names.map(quoteIdentifier).join(", ");
          const rowBytes = rowBytesSql(names);
          const threadColumn = names.includes("thread_id")
            ? 'CASE WHEN length(CAST("thread_id" AS BLOB)) <= 256 THEN "thread_id" END'
            : "NULL";
          yield* sql.unsafe(
            `INSERT INTO t3_import_oversized SELECT ?, ${threadColumn}, ${rowBytes} FROM src.${quoteIdentifier(table)} WHERE (${rowBytes}) > ?`,
            [table, limits.rowBytes],
          );
          yield* sql.unsafe(
            `INSERT INTO main.${quoteIdentifier(table)} (${list}) SELECT ${list} FROM src.${quoteIdentifier(table)} WHERE (${rowBytes}) <= ?`,
            [limits.rowBytes],
          );
        }
      }),
    );
    yield* sql`DETACH DATABASE src`;
    yield* runMigrations();
    yield* io(anchors.revalidate);
    const after = yield* io(() => NodeFSP.lstat(sourcePath));
    if (after.dev !== sourceStat.dev || after.ino !== sourceStat.ino || after.isSymbolicLink())
      return yield* new T3ImportError({ reason: "source-changed", stage: "database" });
    return head;
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(sourceError));
  const schemaHead = yield* staging;
  const projectionsContext = yield* Layer.build(
    ProjectionStore.layer.pipe(Layer.fresh, Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
  );
  return {
    sql,
    projections: Context.get(projectionsContext, ProjectionStore.ProjectionStoreV2),
    environmentId,
    schemaHead,
    directory: input.directory,
    home,
    anchors,
  };
}, Effect.mapError(sourceError));

const open = Effect.fn("T3ImportStaging.open")(function* (
  input: Parameters<T3ImportStaging["Service"]["open"]>[0],
) {
  const resources = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(resources, Exit.void));
  return yield* prepare(input).pipe(
    Effect.provideService(Scope.Scope, resources),
    Effect.onError(() =>
      Scope.close(resources, Exit.void).pipe(
        Effect.andThen(io(() => NodeFSP.rm(input.directory, { recursive: true, force: true }))),
        Effect.orDie,
      ),
    ),
  );
});

export const layer = Layer.succeed(T3ImportStaging, T3ImportStaging.of({ open }));
