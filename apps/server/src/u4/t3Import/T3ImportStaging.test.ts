// @effect-diagnostics nodeBuiltinImport:off
// These fixtures verify SQLite metadata and real anchored filesystem reads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { migrationManifest } from "../../persistence/Migrations.ts";
import * as T3ImportStaging from "./T3ImportStaging.ts";
import { createSource, sourceThread, sourceRun, sourceItem } from "./testkit/T3SourceFixture.ts";

const temporary = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-t3-staging-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);
it.effect.each([81, 89, 96])("stages only trusted tables at supported source head %s", (head) =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const source = yield* createSource(directory, head);
    yield* source.apply("thread.created", "thread:a", sourceThread("thread:a"));
    const item = sourceItem("item:a", "thread:a");
    yield* source.apply("turn-item.updated", "thread:a", item);
    const ledger = yield* source.sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      ledger.map((row) => [row.migration_id, row.name]),
      migrationManifest.filter(([id]) => id <= head),
    );
    const columns = yield* source.sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_xinfo('orchestration_v2_projection_turn_items')`;
    assert.strictEqual(
      columns.some((column) => column.name === "inline_work_output"),
      head === 96,
    );
    const stage = yield* T3ImportStaging.T3ImportStaging;
    const snapshot = yield* stage.open({
      sourceHome: source.home,
      directory: NodePath.join(directory, "stage"),
      destinationDb: NodePath.join(directory, "destination.sqlite"),
      destinationEnvironmentId: EnvironmentId.make("destination"),
    });
    assert.strictEqual(snapshot.schemaHead, head);
    const migratedLedger = yield* snapshot.sql<{
      readonly head: number;
    }>`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`;
    assert.strictEqual(migratedLedger[0]?.head, 96);
    const items = yield* snapshot.sql<{
      readonly payload_json: string;
      readonly inline_work_output: number;
    }>`SELECT payload_json, inline_work_output FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id`;
    assert.deepStrictEqual(
      items.map((row) => JSON.parse(row.payload_json)),
      [item],
    );
    assert.deepStrictEqual(
      items.map((row) => row.inline_work_output),
      [0],
    );
    const rows = yield* snapshot.sql<{
      readonly thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
    assert.deepStrictEqual(
      rows.map((r) => r.thread_id),
      ["thread:a"],
    );
    const sourceLedger = yield* source.sql<{
      readonly head: number;
    }>`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`;
    assert.strictEqual(sourceLedger[0]?.head, head);
    assert.strictEqual((yield* snapshot.sql`SELECT 1 FROM auth_sessions`).length, 0);
  }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect.each(["ledger-view", "guard-view", "generated-required", "virtual-table", "column-type"])(
  "refuses source-controlled executable or incompatible schema: %s",
  (kind) =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const source = yield* createSource(directory);
      if (kind === "ledger-view") {
        yield* source.sql`ALTER TABLE effect_sql_migrations RENAME TO old_migrations`;
        yield* source.sql`CREATE VIEW effect_sql_migrations AS SELECT migration_id, name FROM old_migrations`;
      } else if (kind === "guard-view") {
        yield* source.sql`ALTER TABLE projection_threads RENAME TO old_threads`;
        yield* source.sql`CREATE VIEW projection_threads AS SELECT thread_id FROM old_threads`;
      } else {
        yield* source.sql`DROP TABLE mcp_app_model_context`;
        if (kind === "generated-required")
          yield* source.sql`CREATE TABLE mcp_app_model_context (
      thread_id TEXT NOT NULL, item_id TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL,
      text TEXT GENERATED ALWAYS AS (upper(server)) STORED NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, item_id)
    )`;
        else if (kind === "virtual-table")
          yield* source.sql`CREATE VIRTUAL TABLE mcp_app_model_context USING fts5(thread_id, item_id, server, tool, text, updated_at)`;
        else
          yield* source.sql`CREATE TABLE mcp_app_model_context (thread_id INTEGER NOT NULL, item_id TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, item_id))`;
      }
      const stage = yield* T3ImportStaging.T3ImportStaging;
      const result = yield* stage
        .open({
          sourceHome: source.home,
          directory: NodePath.join(directory, "stage"),
          destinationDb: NodePath.join(directory, "destination.sqlite"),
          destinationEnvironmentId: EnvironmentId.make("destination"),
        })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "divergent-schema");
    }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect(
  "copies no extra columns or forged triggers and counts TEXT and BLOB bytes in a declared INTEGER before copying",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const source = yield* createSource(directory);
      yield* source.sql`ALTER TABLE mcp_app_model_context ADD COLUMN ignored TEXT GENERATED ALWAYS AS (server || tool) VIRTUAL`;
      yield* source.sql`CREATE TRIGGER source_only AFTER INSERT ON mcp_app_model_context BEGIN SELECT 42; END`;
      yield* source.sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES ('thread:a', 'item:huge', zeroblob(16777217))`;
      yield* source.sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES ('thread:a', 'item:text', CAST(zeroblob(16777217) AS TEXT))`;
      const stage = yield* T3ImportStaging.T3ImportStaging;
      const snapshot = yield* stage.open({
        sourceHome: source.home,
        directory: NodePath.join(directory, "stage"),
        destinationDb: NodePath.join(directory, "destination.sqlite"),
        destinationEnvironmentId: EnvironmentId.make("destination"),
      });
      assert.strictEqual(
        (yield* snapshot.sql`SELECT 1 FROM sqlite_master WHERE name = 'source_only'`).length,
        0,
      );
      const columns = yield* snapshot.sql<{
        readonly name: string;
      }>`SELECT name FROM pragma_table_xinfo('mcp_app_model_context')`;
      assert.ok(!columns.some((c) => c.name === "ignored"));
      assert.strictEqual(
        (yield* snapshot.sql`SELECT 1 FROM orchestration_v2_turn_item_positions`).length,
        0,
      );
      const omitted = yield* snapshot.sql<{
        readonly row_bytes: number;
      }>`SELECT row_bytes FROM t3_import_oversized WHERE table_name = 'orchestration_v2_turn_item_positions'`;
      assert.strictEqual(omitted.length, 2);
      assert.ok(omitted.every((row) => row.row_bytes > 16777217));
    }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect.each([
  "userdata-symlink",
  "attachments-symlink",
  "writable-userdata",
  "replace-userdata",
  "replace-attachments",
])("refuses unsafe or replaced directory anchors: %s", (kind) =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const source = yield* createSource(directory);
    const userdata = source.userdata,
      attachments = NodePath.join(userdata, "attachments");
    const swap = async (path: string, symlink: boolean) => {
      await NodeFSP.rename(path, path + "-old");
      if (symlink) await NodeFSP.symlink(path + "-old", path);
      else await NodeFSP.mkdir(path, { mode: 0o700 });
    };
    if (kind === "userdata-symlink") yield* Effect.promise(() => swap(userdata, true));
    if (kind === "attachments-symlink") yield* Effect.promise(() => swap(attachments, true));
    if (kind === "writable-userdata") yield* Effect.promise(() => NodeFSP.chmod(userdata, 0o770));
    const hooks = {
      anchorHooks: {
        ...(kind === "replace-userdata" ? { afterUserdata: () => swap(userdata, false) } : {}),
        ...(kind === "replace-attachments"
          ? { afterAttachments: () => swap(attachments, false) }
          : {}),
      },
    };
    const stage = yield* T3ImportStaging.T3ImportStaging;
    const result = yield* stage
      .open({
        sourceHome: source.home,
        directory: NodePath.join(directory, "stage"),
        destinationDb: NodePath.join(directory, "destination.sqlite"),
        destinationEnvironmentId: EnvironmentId.make("destination"),
      })
      .pipe(Effect.provideService(T3ImportStaging.StagingHooks, hooks), Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.ok(["unsafe-source", "source-changed"].includes(result.failure.reason));
  }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect("takes a coherent WAL snapshot and cannot write through the source attachment", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const source = yield* createSource(directory);
    yield* source.apply("thread.created", "thread:a", sourceThread("thread:a"));
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const stage = yield* T3ImportStaging.T3ImportStaging;
    const fiber = yield* stage
      .open({
        sourceHome: source.home,
        directory: NodePath.join(directory, "stage"),
        destinationDb: NodePath.join(directory, "destination.sqlite"),
        destinationEnvironmentId: EnvironmentId.make("destination"),
      })
      .pipe(
        Effect.provideService(T3ImportStaging.StagingHooks, {
          snapshotRead: (sql) =>
            Effect.gen(function* () {
              const write =
                yield* sql`INSERT INTO src.mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at) VALUES ('x', 'x', 'x', 'x', 'x', 'x')`.pipe(
                  Effect.result,
                );
              assert.strictEqual(write._tag, "Failure");
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
        }),
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    yield* source.sql.withTransaction(
      Effect.gen(function* () {
        yield* source.apply("run.created", "thread:a", sourceRun("run:concurrent", "thread:a"));
        yield* source.apply(
          "turn-item.updated",
          "thread:a",
          sourceItem("item:concurrent", "thread:a", { runId: "run:concurrent" }),
        );
      }),
    );
    yield* Deferred.succeed(release, undefined);
    const snapshot = yield* Fiber.join(fiber);
    assert.strictEqual(
      (yield* snapshot.sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = 'run:concurrent'`)
        .length,
      0,
    );
    assert.strictEqual(
      (yield* snapshot.sql`SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:concurrent'`)
        .length,
      0,
    );
    assert.strictEqual(
      (yield* source.sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = 'run:concurrent'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect("preserves quiescent source database and WAL bytes", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const source = yield* createSource(directory);
    yield* source.apply("thread.created", "thread:a", sourceThread("thread:a"));
    const beforeDb = yield* Effect.promise(() => NodeFSP.readFile(source.dbPath));
    const beforeWal = yield* Effect.promise(() => NodeFSP.readFile(source.dbPath + "-wal"));
    const stage = yield* T3ImportStaging.T3ImportStaging;
    yield* stage.open({
      sourceHome: source.home,
      directory: NodePath.join(directory, "stage"),
      destinationDb: NodePath.join(directory, "destination.sqlite"),
      destinationEnvironmentId: EnvironmentId.make("destination"),
    });
    assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(source.dbPath)), beforeDb);
    assert.deepStrictEqual(
      yield* Effect.promise(() => NodeFSP.readFile(source.dbPath + "-wal")),
      beforeWal,
    );
  }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);

it.effect(
  "removes a failed private staging database when SQLite cannot grow during the snapshot copy",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporary,
        source = yield* createSource(directory);
      yield* source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("item:large", "thread:a", { text: "Synthetic large history ".repeat(50_000) }),
      );
      const stage = yield* T3ImportStaging.T3ImportStaging;
      const stagingDirectory = NodePath.join(directory, "stage");
      const result = yield* stage
        .open({
          sourceHome: source.home,
          directory: stagingDirectory,
          destinationDb: NodePath.join(directory, "destination.sqlite"),
          destinationEnvironmentId: EnvironmentId.make("destination"),
        })
        .pipe(
          Effect.provideService(T3ImportStaging.StagingHooks, {
            snapshotRead: (sql) =>
              sql`PRAGMA main.max_page_count = 1`.pipe(Effect.asVoid, Effect.orDie),
          }),
          Effect.result,
        );
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        yield* Effect.promise(() =>
          NodeFSP.stat(stagingDirectory).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
    }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped),
);
