// @effect-diagnostics nodeBuiltinImport:off
// The sealed staging file is bound by owned directory/file descriptors and an in-database nonce.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as C from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { structuralReferences } from "./t3ImportRecords.ts";
import { SOURCE_TABLES, sourceTableName } from "./t3ImportPaging.ts";
import { streamMapped } from "./t3ImportStreaming.ts";
import { ImportLimits, assertLimit, quoteIdentifier, rowBytesSql } from "./t3ImportPlan.ts";
import { encodeJson } from "./t3ImportFieldMap.ts";

const io = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      new C.T3ImportError({ reason: "staging-failed", stage: "private-binding", cause }),
  });
const bindingError = () =>
  new C.T3ImportError({ reason: "staging-failed", stage: "private-binding" });
const same = (a: NodeFS.Stats, b: NodeFS.Stats) => a.dev === b.dev && a.ino === b.ino;

export const buildMappedUnit = Effect.fn("T3Import.buildMappedUnit")(function* (
  source: SqlClient.SqlClient,
  destination: SqlClient.SqlClient,
  directory: string,
  input: Parameters<typeof streamMapped>[2],
  dependencies: (
    privateSql: SqlClient.SqlClient,
  ) => Effect.Effect<void, C.T3ImportError | import("effect/sql/SqlError").SqlError>,
) {
  const limits = yield* ImportLimits;
  const resources = yield* Scope.make();
  const build = Effect.gen(function* () {
    const parent = NodePath.join(directory, "units");
    yield* io(() => NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 }));
    const attempt = NodePath.join(parent, NodeCrypto.randomUUID());
    yield* io(() => NodeFSP.mkdir(attempt, { mode: 0o700 }));
    yield* Scope.addFinalizer(
      resources,
      Effect.promise(() => NodeFSP.rm(attempt, { recursive: true, force: true })),
    );
    const dir = yield* Effect.acquireRelease(
      io(() =>
        NodeFSP.open(
          attempt,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
        ),
      ),
      (file) => Effect.promise(() => file.close()),
    ).pipe(Effect.provideService(Scope.Scope, resources));
    const dirStat = yield* io(() => dir.stat());
    if (
      !dirStat.isDirectory() ||
      dirStat.uid !== process.getuid?.() ||
      (dirStat.mode & 0o077) !== 0
    )
      return yield* bindingError();
    const filename = `/proc/self/fd/${dir.fd}/stage.sqlite`;
    let file = yield* io(() =>
      NodeFSP.open(
        filename,
        NodeFS.constants.O_CREAT |
          NodeFS.constants.O_EXCL |
          NodeFS.constants.O_RDWR |
          NodeFS.constants.O_NOFOLLOW,
        0o600,
      ),
    );
    yield* Scope.addFinalizer(
      resources,
      Effect.promise(() => file.close()),
    );
    const identity = yield* io(() => file.stat());
    const nonce = NodeCrypto.randomBytes(16).toString("hex");
    const tables: Array<{ name: string; columns: ReadonlyArray<string>; count: number }> = [];
    const created: Extract<C.OrchestrationV2DomainEvent, { type: "thread.created" }>[] = [];
    const mapped = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          NodeSqliteClient.layer({ filename, writerWorker: true, checkpointWorker: false }),
        );
        const sql = Context.get(context, SqlClient.SqlClient);
        yield* sql`PRAGMA journal_mode = MEMORY`;
        if (!same(identity, yield* io(() => NodeFSP.lstat(filename)))) return yield* bindingError();
        yield* sql`CREATE TABLE t3i_seal(nonce TEXT NOT NULL)`;
        yield* sql`INSERT INTO t3i_seal VALUES (${nonce})`;
        yield* runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const head = yield* sql<{
          head: number;
        }>`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`;
        const destinationHead = yield* destination<{
          head: number;
        }>`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`;
        if (head[0]?.head !== 96 || destinationHead[0]?.head !== head[0].head)
          return yield* bindingError();
        const names = SOURCE_TABLES.map(sourceTableName);
        const triggers = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(${encodeJson(names)}))`;
        for (const trigger of triggers)
          yield* sql.unsafe(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
        const indexes = yield* sql<{
          name: string;
        }>`SELECT index_schema.name FROM sqlite_master index_schema JOIN pragma_index_list(index_schema.tbl_name) info ON info.name = index_schema.name WHERE index_schema.type = 'index' AND index_schema.sql IS NOT NULL AND info.[unique] = 0 AND index_schema.tbl_name IN (SELECT value FROM json_each(${encodeJson(names)}))`;
        for (const index of indexes) yield* sql.unsafe(`DROP INDEX ${quoteIdentifier(index.name)}`);
        yield* sql`CREATE TABLE t3i_structural_refs(grp TEXT NOT NULL,c1 TEXT NOT NULL,c2 TEXT)`;
        yield* sql`CREATE TABLE t3i_dependency_keys(dep TEXT NOT NULL,tbl TEXT NOT NULL,k1 TEXT NOT NULL,k2 TEXT)`;
        yield* sql`CREATE TABLE t3i_dep_transfer_candidates(dep TEXT NOT NULL,id TEXT NOT NULL)`;
        yield* sql`CREATE INDEX t3i_dependency_lookup ON t3i_dependency_keys(dep,tbl)`;
        yield* dependencies(sql);
        const store = Context.get(
          yield* Layer.build(
            // The server memo map contains the live store; private projections must not reuse it.
            ProjectionStore.layer.pipe(
              Layer.fresh,
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          ),
          ProjectionStore.ProjectionStoreV2,
        );
        const result = yield* streamMapped(source, destination, input, (page) =>
          sql.withTransaction(
            Effect.gen(function* () {
              for (const position of page.positions)
                yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id,turn_item_id,ordinal) VALUES (${position.thread_id},${position.turn_item_id},${position.ordinal})`;
              for (const event of page.events) {
                if (event.type === "thread.created") created.push(event);
                yield* store.apply(event);
              }
              for (const row of page.contexts)
                yield* sql`INSERT INTO mcp_app_model_context (thread_id,item_id,server,tool,text,updated_at) VALUES (${row.thread_id},${row.item_id},${row.server},${row.tool},${row.text},${row.updated_at})`;
              for (const reference of structuralReferences(page.events, page.contexts)) {
                const group = encodeJson([reference.table, reference.columns]);
                yield* sql`INSERT INTO t3i_structural_refs SELECT ${group}, json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${encodeJson(reference.keys)})`;
              }
            }),
          ),
        );
        yield* sql`CREATE TABLE t3i_encoded_bytes(tbl TEXT PRIMARY KEY,bytes INTEGER NOT NULL)`;
        for (const [table, bytes] of Object.entries(result.encodedBytesByTable))
          yield* sql`INSERT INTO t3i_encoded_bytes VALUES (${table},${bytes})`;
        yield* sql`CREATE TABLE t3i_expected(tbl TEXT PRIMARY KEY,count INTEGER NOT NULL)`;
        for (const [table, count] of Object.entries(result.counts))
          yield* sql`INSERT INTO t3i_expected VALUES (${table},${count})`;
        return result;
      }),
    );
    const scan = async () => {
      const found: number[] = [];
      for (const name of await NodeFSP.readdir("/proc/self/fd")) {
        try {
          if (same(identity, await NodeFSP.stat(`/proc/self/fd/${name}`))) found.push(Number(name));
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
      }
      if (found.length !== 1 || found[0] !== file.fd) throw bindingError();
      const info = await NodeFSP.readFile(`/proc/self/fdinfo/${file.fd}`, "utf8");
      return Number.parseInt(/^flags:\s*(\d+)$/m.exec(info)?.[1] ?? "-1", 8) & 3;
    };
    if ((yield* io(scan)) !== NodeFS.constants.O_RDWR) return yield* bindingError();
    yield* io(() => file.sync());
    yield* io(() => file.chmod(0o400));
    const readonly = yield* io(() =>
      NodeFSP.open(filename, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW),
    );
    if (!same(identity, yield* io(() => readonly.stat()))) {
      yield* io(() => readonly.close());
      return yield* bindingError();
    }
    yield* io(() => file.close());
    file = readonly;
    if ((yield* io(scan)) !== NodeFS.constants.O_RDONLY) return yield* bindingError();
    let storedBytes = 0,
      storedRows = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          NodeSqliteClient.layer({ filename, readonly: true, checkpointWorker: false }),
        );
        const sql = Context.get(context, SqlClient.SqlClient);
        const seal = yield* sql<{ nonce: string }>`SELECT nonce FROM t3i_seal`;
        if (seal[0]?.nonce !== nonce) return yield* bindingError();
        for (const table of SOURCE_TABLES) {
          const name = sourceTableName(table);
          const columns = yield* sql<{
            name: string;
          }>`SELECT name FROM pragma_table_xinfo(${name}) WHERE hidden = 0 ORDER BY cid`;
          const bytes = rowBytesSql(columns.map((column) => column.name));
          const aggregate = yield* sql.unsafe<{ count: number; bytes: number; maximum: number }>(
            `SELECT COUNT(*) AS count,COALESCE(SUM(${bytes}),0) AS bytes,COALESCE(MAX(${bytes}),0) AS maximum FROM ${quoteIdentifier(name)}`,
          );
          if (aggregate[0]!.count !== mapped.counts[name]) return yield* bindingError();
          assertLimit("rowBytes", aggregate[0]!.maximum, limits);
          storedBytes += aggregate[0]!.bytes;
          storedRows += aggregate[0]!.count;
          tables.push({
            name,
            columns: columns.map((column) => column.name),
            count: aggregate[0]!.count,
          });
        }
        assertLimit("rows", storedRows, limits);
        assertLimit("unitBytes", storedBytes, limits);
      }),
    );
    const sealed = yield* io(() => file.stat());
    const hash = async () => {
      const hash = NodeCrypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 ** 2);
      let position = 0;
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, position);
        if (!read.bytesRead) return hash.digest("hex");
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
    };
    const sealedHash = yield* io(hash);
    const verify = async () => {
      const directoryNow = await NodeFSP.lstat(attempt);
      const now = await NodeFSP.lstat(filename);
      if (
        !same(dirStat, directoryNow) ||
        !same(identity, now) ||
        !now.isFile() ||
        now.nlink !== 1 ||
        now.uid !== process.getuid?.() ||
        (now.mode & 0o777) !== 0o400 ||
        now.size !== sealed.size ||
        (await scan()) !== NodeFS.constants.O_RDONLY ||
        (await hash()) !== sealedHash
      )
        throw bindingError();
    };
    yield* io(verify);
    return {
      filename,
      nonce,
      size: sealed.size,
      sha256: sealedHash,
      tables,
      created,
      mapped,
      storedBytes,
      verify,
      verifyIdentity: async () => {
        if (
          !same(identity, await NodeFSP.lstat(filename)) ||
          !same(dirStat, await NodeFSP.lstat(attempt))
        )
          throw bindingError();
      },
      dispose: Scope.close(resources, Exit.void),
    };
  });
  return yield* build.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Scope.close(resources, Exit.void) : Effect.void,
    ),
  );
});
