// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Finite synthetic benchmark; the supervisor must authorize representative generation.
import * as NodeTimers from "node:timers";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as C from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  makeTestAdapter,
  type CapturedTurn,
} from "../../../orchestration-v2/testkit/ProviderSwitchAdapter.ts";
import { sourceThread, sourceRun, sourceItem, FIXTURE_TIME } from "./T3SourceFixture.ts";
import * as T3ImportService from "../T3ImportService.ts";
import * as NodeModule from "node:module";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { harness, selection } from "./T3ImportHarness.ts";
import { generateCorpusUnit, type CorpusShape } from "./LargeCorpusFixture.ts";
import { verifyImportedRecord } from "./ImportFidelity.ts";
import { forEachSourcePage, SOURCE_TABLES, sourceTableName } from "../t3ImportPaging.ts";
import { encodeJson, readRecord } from "../t3ImportFieldMap.ts";
import { TABLE_KEYS } from "../t3ImportRecords.ts";
import {
  destinationId,
  digest,
  IMPORT_LIMITS,
  RECORD_TABLES,
  SNAPSHOT_TABLES,
  rowBytesSql,
  PROJECTION_PREFIX,
  quoteIdentifier,
  type UnitKey,
} from "../t3ImportPlan.ts";

const small = process.argv.includes("--small");
const exercise = process.argv.includes("--small-contention");
const smallCaps = small && process.argv.includes("--small-caps");
const peers = !small || exercise;
const scratch = process.env.U4_IMPORT_BENCH_SCRATCH;
const output = process.env.U4_IMPORT_BENCH_REPORT;
const corpusFile = process.env.U4_IMPORT_BENCH_CORPUS;
const utc = () => DateTime.formatIso(DateTime.nowUnsafe());
const decodeEvent = Schema.decodeUnknownEffect(C.OrchestrationV2DomainEventJson);
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
if (!small && (!scratch || !output || !process.env.U4_IMPORT_BENCH_ADMITTED))
  throw new Error("Representative generation requires the foreground supervisor's admission");
const completedStages = new Set<string>();
const timings: Array<{ filename: string; sql: string; milliseconds: number }> = [];
const workers = NodeModule.createRequire(import.meta.url)(
  "node:worker_threads",
) as typeof NodeWorkerThreads;
const OriginalWorker = workers.Worker;
class MeasuredWorker extends OriginalWorker {
  constructor(filename: string | URL, options?: NodeWorkerThreads.WorkerOptions) {
    if (
      typeof filename === "string" &&
      options?.eval &&
      filename.includes('const { DatabaseSync } = require("node:sqlite")') &&
      !options.workerData?.readOnly
    ) {
      filename = filename.replace(
        '  let operation = "open";',
        '  let operation = "open"; const benchStart = process.hrtime.bigint();',
      );
      filename = filename.replace(
        "      const result = statement.run(...params);",
        '      const result = statement.run(...params); if (/^\\s*(BEGIN|COMMIT|ROLLBACK)\\b/i.test(sql)) parentPort.postMessage({type:"bench_tx",sql,at:Number(process.hrtime.bigint())/1e6,elapsed:Number(process.hrtime.bigint()-benchStart)/1e6});',
      );
    }
    super(filename, options);
    this.on("message", (message: { type?: string; sql: string; at: number; elapsed: number }) => {
      if (message.type === "bench_tx")
        timings.push({
          filename: options?.workerData?.filename ?? "",
          sql: message.sql,
          milliseconds: message.at,
        });
    });
  }
}
Object.assign(workers, { Worker: MeasuredWorker });
NodeModule.syncBuiltinESMExports();

const report: {
  schema: string;
  small: boolean;
  startedUTC: string;
  finishedUTC?: string;
  failures: string[];
  diagnostics: string[];
  measurements: Array<Record<string, unknown>>;
  notRun: string[];
} = {
  schema: "u4-import-representative-benchmark/1",
  small,
  startedUTC: utc(),
  failures: [],
  diagnostics: [],
  measurements: [],
  notRun: [],
};
const gate = (condition: boolean, failure: string) => {
  if (!condition) {
    report.failures.push(failure);
    throw new Error(failure);
  }
};
const tinyTables = Object.fromEntries(
  RECORD_TABLES.filter((table) => table !== "context_transfers").map((table) => [
    table,
    { rows: table === "threads" ? 3 : 1, columnBytes: table === "threads" ? 8000 : 4000 },
  ]),
);
for (const table of ["runs", "run_attempts", "nodes", "provider_turns", "messages", "turn_items"])
  tinyTables[table] = { rows: 5, columnBytes: 4000 };
tinyTables.turn_item_positions = { rows: 5, columnBytes: 1000 };
const tiny: CorpusShape = {
  name: "small",
  members: 3,
  sourceRows: 47,
  sourceColumnBytes: 52000,
  maxRowBytes: 4096,
  incidentTransfers: 5,
  assetReferences: 1,
  assetReferencedBytes: 128,
  tables: tinyTables,
};
const loop = NodePerfHooks.monitorEventLoopDelay({ resolution: 1 });
const now = () => NodePerfHooks.performance.now();
const allJob = Effect.fn("ImportBench.allJob")(function* (
  importer: Effect.Success<ReturnType<typeof harness>>["importer"],
  jobId: C.T3ImportJobId,
) {
  const first = yield* importer.getJob({ jobId });
  const results = [...first.results];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = yield* importer.getJob({ jobId, cursor });
    results.push(...page.results);
    cursor = page.nextCursor;
  }
  return { ...first, results, nextCursor: null };
});
const peer = Effect.fn("ImportBench.peer")(function* (mode: string, filename: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [new URL("./ImportBenchmarkPeer.ts", import.meta.url).pathname, mode, filename, scratch!],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: Array<Record<string, unknown>> = [];
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const ready = new Promise<void>((resolve, reject) => {
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = parseJson(line) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "ready") resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!messages.some((m) => m.type === "ready"))
        reject(new Error("Peer failed before ready: " + code + " " + errors));
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end("stop\n");
      const code = await closed;
      report.measurements.push({
        phase: "peer-cleanup",
        mode,
        pid: child.pid,
        code,
        errors,
        messages,
      });
    }),
  );
  yield* Effect.promise(() => ready);
  return { child, closed, messages };
});
const checksumFile = async (filename: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
};
const continuation = Effect.fn("ImportBench.continuation")(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  thread: string,
) {
  const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const cwd = yield* checkpointWorkspace("large-import-chain");
  const model: C.ModelSelection = { instanceId: C.ProviderInstanceId.make("codex"), model: "test" };
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    makeTestAdapter({
      instanceId: model.instanceId,
      driver: C.ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      modelSelection: model,
      capturedTurns: captured,
      responseByRunOrdinal: {},
    }),
  ]);
  let payloadRows = 0,
    estimateRows = 0,
    necessaryRows = 0,
    inheritedRows = 0,
    recoveryRows = 0;
  const observed = new WeakSet<object>();
  const observe: Statement.Transformer = (statement) =>
    Effect.withFiber((fiber) =>
      Effect.sync(() => {
        let span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
        let recovery = false;
        while (span?._tag === "Span") {
          const spanName = span.name;
          recovery ||= ["prepareRecoveryHandoff", "prepareRetryHandoff"].some((name) =>
            spanName.endsWith(name),
          );
          span = Option.getOrUndefined(span.parent);
        }
        if (observed.has(statement)) return statement;
        observed.add(statement);
        const [query, params] = statement.compile();
        if (
          !query.includes("orchestration_v2_projection_turn_items") ||
          !query.includes("payload_json")
        )
          return statement;
        const typeIndex = params.indexOf(encodeJson(ProjectionStore.HISTORICAL_ITEM_TYPES));
        const historical =
          typeIndex !== -1 ||
          ["'assistant_message'", "'proposed_plan'", "'run_interrupt_result'"].every((type) =>
            query.includes(type),
          );
        const native =
          typeIndex !== -1 &&
          query.includes("provider_thread_id =") &&
          params[typeIndex + 1] !== null;
        const prior = (
          statement as Statement.Statement<unknown> & {
            transformRows?: <A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>;
          }
        ).transformRows;
        return Object.assign(statement, {
          transformRows: <A extends object>(rows: ReadonlyArray<A>) => {
            const count = rows.filter(
              (row) => "payload_json" in row && typeof row.payload_json === "string",
            ).length;
            if (recovery) recoveryRows += count;
            else if (!historical) necessaryRows += count;
            else if (native) estimateRows += count;
            else if (!params.includes(thread)) inheritedRows += count;
            else payloadRows += count;
            return prior ? prior(rows) : rows;
          },
        });
      }),
    );
  yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    let session: string | undefined;
    for (let turn = 1; turn <= 5; turn++) {
      const threadId = C.ThreadId.make(thread);
      const sequence = yield* sink.latestSequence({ threadId });
      payloadRows = 0;
      estimateRows = 0;
      necessaryRows = 0;
      inheritedRows = 0;
      recoveryRows = 0;
      loop.reset();
      const memory = process.memoryUsage();
      const start = now();
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: C.CommandId.make("bench:continue:" + thread + ":" + turn),
        threadId,
        messageId: C.MessageId.make("message:bench:" + thread + ":" + turn),
        createdBy: "user",
        creationSource: "web",
        text: "Recall the synthetic release marker.",
        attachments: [],
        modelSelection: model,
        dispatchMode: { type: "start_immediately" },
      });
      const terminal = yield* sink
        .stream({ threadId, afterSequence: sequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (event) =>
              event.event.type === "run.updated" &&
              ["completed", "failed", "interrupted", "cancelled"].includes(
                event.event.payload.status,
              ),
          ),
          Stream.take(1),
          Stream.runHead,
        );
      gate(
        Option.isSome(terminal) &&
          terminal.value.event.type === "run.updated" &&
          terminal.value.event.payload.status === "completed",
        "deterministic continuation did not complete successfully",
      );
      yield* worker.drain();
      const milliseconds = now() - start,
        heap = process.memoryUsage().heapUsed - memory.heapUsed;
      const turns = yield* Ref.get(captured);
      const current = turns.at(-1);
      report.measurements.push({
        phase: "continuation",
        thread,
        turn,
        milliseconds,
        heap,
        payloadRows,
        estimateRows,
        necessaryRows,
        inheritedRows,
        recoveryRows,
        promptBytes: Buffer.byteLength(current?.text ?? ""),
        eventLoopMax: loop.max / 1e6,
      });
      gate(turns.length === turn, "deterministic provider did not accept continuation");
      if (turn === 1) {
        gate(
          payloadRows > 0 && Buffer.byteLength(current!.text) > 36,
          "first run-fork delivery lacked inherited/own history or its positive SQL counter",
        );
        session = current?.nativeThreadId ?? undefined;
        gate(
          milliseconds <= 3000 && heap <= 256 * 1024 ** 2 && loop.max / 1e6 <= 250,
          "first continuation performance gate failed",
        );
        gate(
          Buffer.byteLength(current?.text ?? "") <= 64_000 + 2048,
          "first continuation exceeded configured handoff budget",
        );
      }
      if (turn === 2 || turn === 5) {
        gate(
          milliseconds <= 300 && heap <= 32 * 1024 ** 2 && payloadRows + inheritedRows === 0,
          "subsequent continuation performance or redundant payload gate failed",
        );
        gate(current?.nativeThreadId === session, "subsequent continuation changed native session");
      }
    }
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        {
          name: "large-import-chain",
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        registry,
        { databaseLayer: Layer.succeed(SqlClient.SqlClient, h.sql), recoverOnStartup: false },
      ),
    ),
    Effect.provideService(Statement.CurrentTransformer, observe),
  );
});
const diskBytes = (root: string) => {
  const seen = new Set<string>();
  let bytes = 0;
  const visit = (path: string) => {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const key = stat.dev + ":" + stat.ino;
    if (seen.has(key)) return;
    seen.add(key);
    bytes += Math.max(stat.size, stat.blocks * 512);
    if (stat.isDirectory())
      for (const name of NodeFS.readdirSync(path)) visit(NodePath.join(path, name));
  };
  visit(root);
  return bytes;
};
const watchStorage = (root: string) => {
  const baseline = diskBytes(root);
  let peak = baseline,
    stopped = false;
  const sample = () => {
    peak = Math.max(peak, diskBytes(root));
  };
  const timer = NodeTimers.setInterval(sample, 50);
  return () => {
    if (!stopped) {
      stopped = true;
      NodeTimers.clearInterval(timer);
      sample();
    }
    return { baseline, peak, growth: peak - baseline };
  };
};
const sourceByteCount = Effect.fn("ImportBench.sourceByteCount")(function* (
  source: Effect.Success<ReturnType<typeof harness>>["source"],
) {
  let bytes = 0;
  for (const table of SNAPSHOT_TABLES) {
    const columns = yield* source.sql<{
      name: string;
    }>`SELECT name FROM pragma_table_xinfo(${table}) WHERE hidden=0`;
    const rows = yield* source.sql.unsafe<{ bytes: number }>(
      `SELECT COALESCE(SUM(${rowBytesSql(columns.map((column) => column.name))}),0) AS bytes FROM ${quoteIdentifier(table)}`,
    );
    bytes += rows[0]!.bytes;
  }
  return bytes;
});
const findStage = (root: string, filename = "stage.sqlite"): string | undefined => {
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const path = NodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findStage(path, filename);
      if (found) return found;
    } else if (entry.name === filename) return path;
  }
  return undefined;
};
const verifyUnit = Effect.fn("ImportBench.verifyUnit")(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  sourceDatabase: Effect.Success<ReturnType<typeof harness>>["source"],
  unit: {
    readonly root: string;
    readonly members: ReadonlyArray<string>;
    readonly shape: { readonly name: string };
    readonly assets: ReadonlyArray<{
      sourceId: string;
      sha256: string;
      sidecarSha256: string | null;
    }>;
  },
  projectRoot: string,
  prefilled: boolean,
  referenceKey: (id: string) => UnitKey | undefined = () => undefined,
) {
  const key: UnitKey = ["environment:synthetic-t3", unit.root, 1];
  const projectRows = yield* sourceDatabase.sql<{
    project_id: string;
    workspace_root: string;
  }>`SELECT project_id,workspace_root FROM projection_projects WHERE project_id IN (SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT value FROM json_each(${encodeJson(unit.members)})))`;
  const projectKeys = new Map<string, UnitKey>();
  for (const project of projectRows) {
    gate(
      project.workspace_root === projectRoot ||
        project.workspace_root.startsWith(projectRoot + NodePath.sep),
      "synthetic project escaped its owned fixture",
    );
    projectKeys.set(project.project_id, [
      "environment:synthetic-t3",
      "project:" + project.project_id + ":" + digest(project.workspace_root),
      1,
    ]);
  }
  const importedRoot = yield* h.store.getThread(C.ThreadId.make(destinationId(unit.root, key)));
  const ownedTransfers = new Set(importedRoot.importedFrom?.ownedTransferIds ?? []);
  const counts: Record<string, number> = {};
  const scalarLedger = NodeCrypto.createHash("sha256");
  for (const table of SOURCE_TABLES) {
    counts[table] = 0;
    yield* forEachSourcePage(sourceDatabase.sql, unit.members, table, (rows) =>
      Effect.gen(function* () {
        if (prefilled && rows.length) {
          const name = sourceTableName(table);
          const keys =
            table === "positions"
              ? ["thread_id", "turn_item_id"]
              : table === "contexts"
                ? ["thread_id", "item_id"]
                : [TABLE_KEYS[table]];
          const columns = Object.keys(rows[0]!);
          const original = yield* h.sql.unsafe<Record<string, unknown>>(
            `SELECT ${columns.map((column) => "stored." + quoteIdentifier(column)).join(",")} FROM ${quoteIdentifier(name)} stored JOIN json_each(?) expected ON ${keys.map((key, index) => `stored.${quoteIdentifier(key)}=json_extract(expected.value,'$[${index}]')`).join(" AND ")}`,
            [encodeJson(rows.map((row) => keys.map((key) => row[key])))],
          );
          const originals = new Map(
            original.map((row) => [encodeJson(keys.map((key) => row[key])), row]),
          );
          for (const row of rows)
            gate(
              encodeJson(originals.get(encodeJson(keys.map((key) => row[key])))) ===
                encodeJson(row),
              "prefilled unrelated row changed: " + table,
            );
        }
        if (table === "positions" || table === "contexts") {
          for (const row of rows) {
            const thread = destinationId(String(row.thread_id), key);
            const column = table === "positions" ? "turn_item_id" : "item_id";
            const mapped = destinationId(
              String(row[column]),
              table === "contexts" ? (referenceKey(String(row[column])) ?? key) : key,
            );
            const stored = yield* h.sql.unsafe<Record<string, unknown>>(
              `SELECT * FROM ${quoteIdentifier(sourceTableName(table))} WHERE thread_id = ? AND ${quoteIdentifier(column)} = ?`,
              [thread, mapped],
            );
            gate(stored.length === 1, "missing composite row: " + table);
            for (const [name, value] of Object.entries(row))
              if (name !== "thread_id" && name !== column)
                gate(
                  encodeJson(stored[0]![name]) === encodeJson(value),
                  "composite payload changed: " + table + "." + name,
                );
            counts[table] = (counts[table] ?? 0) + 1;
          }
        } else {
          const ids = rows.map((row) => destinationId(String(row[TABLE_KEYS[table]]), key));
          const stored = yield* h.sql.unsafe<{ payload_json: string }>(
            `SELECT payload_json FROM ${quoteIdentifier(PROJECTION_PREFIX + table)} WHERE ${quoteIdentifier(TABLE_KEYS[table])} IN (SELECT value FROM json_each(?))`,
            [encodeJson(ids)],
          );
          if (table === "messages")
            for (const term of [undefined, "synthetic"]) {
              const sourceIndexed = yield* sourceDatabase.sql.unsafe<{
                message_id: string;
              }>(
                `SELECT message.message_id FROM orchestration_v2_projection_messages message JOIN orchestration_v2_message_search search ON search.rowid=message.rowid WHERE message.message_id IN (SELECT value FROM json_each(?))${term ? " AND orchestration_v2_message_search MATCH 'synthetic'" : ""}`,
                [encodeJson(rows.map((row) => row.message_id))],
              );
              const indexed = yield* h.sql.unsafe<{ message_id: string }>(
                `SELECT message.message_id FROM orchestration_v2_projection_messages message JOIN orchestration_v2_message_search search ON search.rowid=message.rowid WHERE message.message_id IN (SELECT value FROM json_each(?))${term ? " AND orchestration_v2_message_search MATCH 'synthetic'" : ""}`,
                [encodeJson(ids)],
              );
              gate(
                encodeJson(
                  sourceIndexed.map((row) => destinationId(row.message_id, key)).sort(),
                ) === encodeJson(indexed.map((row) => row.message_id).sort()),
                "FTS logical ID, subagent exclusion, or term admission mismatch",
              );
            }
          const byId = new Map(
            stored.map((row) => {
              const value = readRecord(table, row.payload_json);
              return [String(value.id), value] as const;
            }),
          );
          for (const row of rows) {
            const source = readRecord(table, String(row.payload_json));
            if (table === "context_transfers")
              gate(
                ownedTransfers.has(C.ContextTransferId.make(destinationId(String(source.id), key))),
                "mapped transfer ownership omits preserved source transfer",
              );
            const target = byId.get(destinationId(String(source.id), key));
            gate(target !== undefined, "missing stored record: " + table);
            const verified = verifyImportedRecord(table, source, target!, key, {
              get: (id: string) => projectKeys.get(id) ?? referenceKey(id),
            });
            scalarLedger.update(encodeJson(verified));
            if (
              table === "messages" &&
              Array.isArray(source.attachments) &&
              Array.isArray(target!.attachments)
            )
              for (const [index, attachment] of source.attachments.entries()) {
                if (typeof attachment !== "object" || attachment === null || !("id" in attachment))
                  continue;
                const expected = unit.assets.find((asset) => asset.sourceId === attachment.id);
                const actual = target!.attachments[index] as { id: string };
                gate(
                  parseThreadSegmentFromAttachmentId(actual.id) ===
                    toSafeThreadAttachmentSegment(String(target!.threadId)),
                  "asset ownership differs from mapped message owner",
                );
                gate(!!expected, "asset reference lacks independent source checksum");
                gate(
                  (yield* Effect.promise(() =>
                    checksumFile(NodePath.join(h.config.attachmentsDir, actual.id + ".pdf")),
                  )) === expected!.sha256,
                  "asset checksum mismatch",
                );
                gate(
                  (yield* Effect.promise(() =>
                    checksumFile(NodePath.join(h.config.attachmentsDir, actual.id + ".pdf.txt")),
                  )) === expected!.sidecarSha256,
                  "sidecar checksum mismatch",
                );
              }
            counts[table] = (counts[table] ?? 0) + 1;
          }
        }
      }),
    );
  }
  gate(
    ownedTransfers.size === counts.context_transfers,
    "mapped transfer ownership count differs from preserved rows",
  );
  report.measurements.push({
    phase: "fidelity",
    unit: unit.shape.name,
    counts,
    scalarLedger: scalarLedger.digest("hex"),
  });
});
const prefill = Effect.fn("ImportBench.prefill")(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  source: Effect.Success<ReturnType<typeof harness>>["source"],
) {
  yield* h.sql`ATTACH DATABASE ${"file:" + source.dbPath + "?mode=ro"} AS bench_source`;
  yield* h.sql.withTransaction(
    Effect.gen(function* () {
      for (const table of ["projection_projects", ...SOURCE_TABLES.map(sourceTableName)]) {
        const columns = yield* source.sql<{
          name: string;
        }>`SELECT name FROM pragma_table_xinfo(${table}) WHERE hidden=0 ORDER BY cid`;
        const names = columns.map((column) => quoteIdentifier(column.name)).join(",");
        yield* h.sql.unsafe(
          `INSERT INTO main.${quoteIdentifier(table)} (${names}) SELECT ${names} FROM bench_source.${quoteIdentifier(table)}`,
        );
      }
      yield* h.sql`UPDATE projection_projects SET workspace_root=workspace_root||'/prefilled'`;
    }),
  );
  yield* h.sql`DETACH DATABASE bench_source`;
});
const focusedProofs = Effect.fn("ImportBench.focusedProofs")(function* () {
  const log = NodePath.join(scratch!, "benchmark-regressions.log");
  const stream = NodeFS.createWriteStream(log, { mode: 0o600 });
  const root = NodePath.resolve(new URL("../../../../../../", import.meta.url).pathname);
  const args = [
    "test",
    "run",
    "apps/server/src/u4/t3Import/T3ImportService.test.ts",
    "packages/shared/src/nodeSqliteClient.test.ts",
    "apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts",
    "--no-file-parallelism",
  ];
  const child = NodeChildProcess.spawn(NodePath.join(root, "node_modules/.bin/vp"), args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const result = yield* Effect.promise(
    () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
  );
  yield* Effect.promise(() => new Promise<void>((resolve) => stream.end(resolve)));
  report.measurements.push({
    phase: "interruption-recovery-and-visibility-regressions",
    pid: child.pid,
    args,
    log,
    ...result,
  });
  gate(
    result.code === 0,
    "real SQLite interruption, crash, unknown, visibility or continuation regression failed",
  );
  completedStages.add("focused-proofs");
});
const capScenarios = Effect.fn("ImportBench.capScenarios")(function* () {
  for (const kind of ["cap", "singleton", "dense-short-multilingual"] as const)
    yield* Effect.scoped(
      Effect.gen(function* () {
        let h: Effect.Success<ReturnType<typeof harness>>;
        let offset = 0,
          hold = Infinity,
          cancelAt = 0;
        let cancelJob: string | undefined;
        let cancelled = false;
        let unit: Effect.Success<ReturnType<typeof generateCorpusUnit>>;
        let publicationStart = 0,
          publicationMs = 0;
        const hooks = {
          milestone: (stage: string) =>
            Effect.gen(function* () {
              if (stage === "after-unit-staging" && kind === "cap") {
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const filename = findStage(h.config.stateDir)!;
                    const sql = Context.get(
                      yield* Layer.build(
                        NodeSqliteClient.layer({
                          filename,
                          readonly: true,
                          writerWorker: true,
                          checkpointWorker: false,
                        }),
                      ),
                      SqlClient.SqlClient,
                    );
                    const expected = yield* sql<{
                      rows: number;
                    }>`SELECT SUM(count) AS rows FROM t3i_expected`;
                    const encoded = yield* sql<{
                      bytes: number;
                    }>`SELECT SUM(bytes) AS bytes FROM t3i_encoded_bytes`;
                    let storedRows = 0,
                      storedBytes = 0;
                    for (const table of SOURCE_TABLES) {
                      const name = sourceTableName(table);
                      const columns = yield* sql<{
                        name: string;
                      }>`SELECT name FROM pragma_table_xinfo(${name}) WHERE hidden=0`;
                      const measured = yield* sql.unsafe<{ rows: number; bytes: number }>(
                        `SELECT COUNT(*) AS rows,COALESCE(SUM(${rowBytesSql(columns.map((column) => column.name))}),0) AS bytes FROM ${quoteIdentifier(name)}`,
                      );
                      storedRows += measured[0]!.rows;
                      storedBytes += measured[0]!.bytes;
                    }
                    const domains = {
                      source: { rows: unit.sourceRows, bytes: unit.sourceBytes },
                      mapped: { rows: expected[0]!.rows, bytes: encoded[0]!.bytes },
                      stored: { rows: storedRows, bytes: storedBytes },
                    };
                    report.measurements.push({
                      phase: "cap-domains",
                      kind,
                      limits: { rows: IMPORT_LIMITS.rows, unitBytes: IMPORT_LIMITS.unitBytes },
                      assets: unit.assets.length,
                      domains,
                    });
                    gate(
                      Object.values(domains).every(
                        (domain) =>
                          domain.rows <= IMPORT_LIMITS.rows &&
                          domain.bytes <= IMPORT_LIMITS.unitBytes,
                      ),
                      "cap accounting domain exceeds actual production limits",
                    );
                    if (!smallCaps)
                      gate(
                        Object.values(domains).every(
                          (domain) =>
                            domain.rows >= IMPORT_LIMITS.rows - 2 &&
                            domain.bytes >= IMPORT_LIMITS.unitBytes * 0.9,
                        ),
                        "cap accounting domain is not near actual production limits",
                      );
                  }),
                ).pipe(Effect.orDie);
                publicationStart = now();
              }
              if (stage === "assets-published" && kind === "cap")
                publicationMs = now() - publicationStart;
              if (stage === "before-commit") offset = timings.length;
              if (stage === "after-commit") {
                const tx = timings.slice(offset).filter((t) => t.filename === h.config.dbPath);
                const begin = tx.find((t) => /^BEGIN IMMEDIATE/i.test(t.sql));
                const commit = tx.findLast((t) => /^COMMIT/i.test(t.sql));
                hold = begin && commit ? commit.milliseconds - begin.milliseconds : Infinity;
              }
              if (stage === "after-unit-staging" && cancelJob && !cancelled) {
                cancelled = true;
                cancelAt = now();
                yield* h.importer.cancel({ jobId: C.T3ImportJobId.make(cancelJob) });
              }
            }),
        };
        h = yield* harness(undefined, 81).pipe(
          Effect.provideService(T3ImportService.ImportHooks, hooks),
        );
        const assets = kind === "cap" ? (smallCaps ? 2 : IMPORT_LIMITS.assets) : 1;
        const itemRows =
          kind === "cap"
            ? smallCaps
              ? 5
              : Math.floor((IMPORT_LIMITS.rows - assets - 12) / 2)
            : kind === "singleton"
              ? 1
              : smallCaps
                ? 100
                : 1000;
        const tables = Object.fromEntries(
          RECORD_TABLES.filter((table) => table !== "context_transfers").map((table) => [
            table,
            {
              rows: table === "turn_items" ? itemRows : table === "messages" ? assets : 1,
              columnBytes:
                table === "turn_items"
                  ? kind === "cap"
                    ? smallCaps
                      ? itemRows * 4096
                      : IMPORT_LIMITS.unitBytes -
                        4 * 1024 ** 2 -
                        itemRows * 130 -
                        assets * 1024 -
                        11 * 4096
                    : itemRows * 4096
                  : table === "messages"
                    ? assets * 1024
                    : 4096,
            },
          ]),
        );
        tables.turn_item_positions = {
          rows: itemRows,
          columnBytes: itemRows * (kind === "dense-short-multilingual" ? 56 : 130),
        };
        const sourceRows = 10 + assets + 2 * itemRows;
        const sourceColumnBytes =
          Object.values(tables).reduce((sum, table) => sum + table.columnBytes, 0) + 4096;
        const shape: CorpusShape = {
          name: kind,
          ...(kind === "dense-short-multilingual" ? { idLength: 24 } : {}),
          members: 1,
          sourceRows,
          sourceColumnBytes,
          maxRowBytes: kind === "singleton" ? (smallCaps ? 16 * 1024 : 16 * 1024 ** 2) : 4096,
          incidentTransfers: 1,
          assetReferences: assets,
          assetReferencedBytes: assets * 128,
          tables,
        };
        unit = yield* generateCorpusUnit(
          h.source,
          shape,
          kind === "dense-short-multilingual" ? "d" : kind,
        );
        const memory = process.memoryUsage();
        loop.reset();
        const start = now();
        const opened = yield* h.importer.open({ sourceHome: h.source.home });
        yield* h.importer.awaitReady(opened.sessionId);
        const preview = yield* h.importer.preview({
          sessionId: opened.sessionId,
          selection: selection([unit.root]),
        });
        gate(preview.totals.blocked === 0, "capped shape blocked in " + kind);
        const job = yield* h.importer.start({
          sessionId: opened.sessionId,
          planId: preview.planId,
        });
        yield* h.importer.awaitJob(job.jobId);
        const result = yield* allJob(h.importer, job.jobId);
        const heap = process.memoryUsage().heapUsed - memory.heapUsed;
        report.measurements.push({
          phase: "cap-shape",
          kind,
          sourceRows: unit.sourceRows,
          sourceBytes: unit.sourceBytes,
          milliseconds: now() - start,
          publicationMs,
          hold,
          heap,
          eventLoop: { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
          result,
        });
        gate(
          result.results.every((result) => result.outcome === "imported"),
          "capped shape did not import completely: " + kind,
        );
        if (kind === "cap")
          gate(publicationMs <= 60000, "512-asset publication exceeded 60 seconds");
        gate(hold <= 3000, "cap phase F exceeded 3 seconds: " + kind);
        gate(
          heap <= (kind === "singleton" ? 768 : 512) * 1024 ** 2,
          "cap heap gate failed: " + kind,
        );
        gate(
          loop.max / 1e6 <= (kind === "singleton" ? 1000 : 250),
          "singleton or dense event-loop gate failed: " + kind,
        );
        yield* verifyUnit(h, h.source, unit, h.directory, false);
        if (kind === "cap") {
          const next = {
            ...selection([unit.root]),
            newCopyUnitRootIds: [C.ThreadId.make(unit.root)],
          };
          yield* h.sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${FIXTURE_TIME} WHERE thread_id = ${destinationId(unit.root, ["environment:synthetic-t3", unit.root, 1])}`;
          const plan = yield* h.importer.preview({ sessionId: opened.sessionId, selection: next });
          const started = yield* h.importer.start({
            sessionId: opened.sessionId,
            planId: plan.planId,
          });
          cancelJob = started.jobId;
          yield* h.importer.awaitJob(started.jobId);
          const cancelledResult = yield* allJob(h.importer, started.jobId);
          gate(
            cancelled && cancelledResult.status === "cancelled" && now() - cancelAt <= 500,
            "large cancellation outside F exceeded 500 ms or committed",
          );
          report.measurements.push({
            phase: "cancel",
            milliseconds: now() - cancelAt,
            result: cancelledResult,
          });
        }
        completedStages.add(kind);
      }),
    );
});
const program = Effect.gen(function* () {
  const closure = small
    ? undefined
    : (parseJson(yield* Effect.promise(() => NodeFSP.readFile(corpusFile!, "utf8"))) as {
        units: CorpusShape[];
      });
  const shapes = small ? [tiny, tiny] : closure!.units.slice(0, 4);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* harness(undefined, 81);
      const sourceUnits: Array<Effect.Success<ReturnType<typeof generateCorpusUnit>>> = [];
      for (const [index, shape] of shapes.entries()) {
        const setupStart = now();
        const unit = yield* generateCorpusUnit(owner.source, shape, "core" + index);
        sourceUnits.push(unit);
        report.measurements.push({
          phase: "generation-unit",
          name: shape.name,
          milliseconds: now() - setupStart,
          setupTransactions: unit.setupTransactions,
          rows: unit.sourceRows,
          bytes: unit.sourceBytes,
        });
        const nativeRows = yield* owner.source.sql<{ count: number; mismatches: number }>`
          WITH members AS (SELECT value FROM json_each(${encodeJson(unit.members)})),
          native AS (
            SELECT provider_thread_id AS id FROM orchestration_v2_projection_runs WHERE thread_id IN members
            UNION ALL SELECT provider_thread_id FROM orchestration_v2_projection_run_attempts WHERE thread_id IN members
            UNION ALL SELECT provider_thread_id FROM orchestration_v2_projection_provider_turns WHERE thread_id IN members
            UNION ALL SELECT json_extract(payload_json,'$.toProviderThreadId') FROM orchestration_v2_projection_context_handoffs WHERE thread_id IN members
          )
          SELECT COUNT(*) AS count, COALESCE(SUM(id <> ${unit.providerThreadId}),0) AS mismatches FROM native
        `;
        gate(
          nativeRows[0]?.mismatches === 0 &&
            nativeRows[0]?.count ===
              ["runs", "run_attempts", "provider_turns", "context_handoffs"].reduce(
                (total, table) => total + unit.sourceTotals[table]!.rows,
                0,
              ),
          "synthetic native identities or related rows are incoherent",
        );
        const transfers = yield* owner.source.sql<{
          invalid: number;
          resultChildren: number;
          resultPoints: number;
          results: number;
          spawns: number;
        }>`
          SELECT COALESCE(SUM(
            json_extract(t.payload_json,'$.sourcePoint.threadId') IS NOT t.source_thread_id
            OR r.thread_id IS NOT t.source_thread_id OR t.status <> 'consumed'
            OR (t.type = 'subagent_result' AND json_extract(src.payload_json,'$.lineage.parentThreadId') IS NOT t.target_thread_id)
            OR (t.type = 'subagent_spawn' AND json_extract(dst.payload_json,'$.lineage.parentThreadId') IS NOT t.source_thread_id)
          ),0) AS invalid,
          COUNT(DISTINCT CASE WHEN t.type='subagent_result' THEN t.source_thread_id END) AS resultChildren,
          COUNT(DISTINCT CASE WHEN t.type='subagent_result' THEN json_extract(t.payload_json,'$.sourcePoint') END) AS resultPoints,
          COALESCE(SUM(t.type='subagent_result'),0) AS results, COALESCE(SUM(t.type='subagent_spawn'),0) AS spawns
          FROM orchestration_v2_projection_context_transfers AS t
          LEFT JOIN orchestration_v2_projection_runs AS r ON r.run_id=json_extract(t.payload_json,'$.sourcePoint.runId')
          LEFT JOIN orchestration_v2_projection_threads AS src ON src.thread_id=t.source_thread_id
          LEFT JOIN orchestration_v2_projection_threads AS dst ON dst.thread_id=t.target_thread_id
          WHERE t.source_thread_id IN (SELECT value FROM json_each(${encodeJson(unit.members)}))
        `;
        const terminalChildren = Math.min(
          unit.members.length - 1,
          unit.count("runs") - Math.max(1, Math.floor(unit.count("runs") * 0.65)),
        );
        report.measurements.push({
          phase: "source-transfer-integrity",
          unit: unit.tag,
          terminalChildren,
          ...transfers[0],
        });
        gate(
          transfers[0]?.invalid === 0 &&
            transfers[0]?.resultChildren === terminalChildren &&
            transfers[0]?.resultPoints === terminalChildren,
          "synthetic child transfers have missing results or invalid owned source points",
        );
        const boundaryResults = yield* owner.source.sql<{
          id: string;
          source: string;
          target: string;
          type: string;
        }>`
          SELECT context_transfer_id AS id,source_thread_id AS source,target_thread_id AS target,type FROM orchestration_v2_projection_context_transfers
          WHERE context_transfer_id IN (SELECT value FROM json_each(${encodeJson([unit.id("context_transfers", 0), unit.id("context_transfers", terminalChildren - 1)])}))
        `;
        gate(
          boundaryResults.find((row) => row.id === unit.id("context_transfers", 0))?.source ===
            unit.members[1] &&
            boundaryResults.find(
              (row) => row.id === unit.id("context_transfers", terminalChildren - 1),
            )?.source === unit.members[terminalChildren] &&
            boundaryResults.every(
              (row) => row.type === "subagent_result" && row.target === unit.root,
            ),
          "synthetic first result or last terminal child mapping is invalid",
        );
        for (const instant of [FIXTURE_TIME, "9999-12-31T00:00:00Z"]) {
          const candidates = yield* owner.source.store.findWorkCandidates(
            unit.members.map((id) => C.ThreadId.make(id)),
            { now: DateTime.makeUnsafe(instant) },
          );
          report.measurements.push({
            phase: "source-eligibility",
            unit: unit.tag,
            instant,
            candidates,
          });
          gate(candidates.length === 0, "synthetic completed unit has recoverable source work");
        }
      }
      const providerTurns = yield* owner.source.sql<{ id: string; count: number }>`
        SELECT provider_thread_id AS id,COUNT(*) AS count FROM orchestration_v2_projection_provider_turns GROUP BY provider_thread_id
      `;
      gate(
        providerTurns.length === sourceUnits.length &&
          sourceUnits.every(
            (unit) =>
              providerTurns.find((row) => row.id === unit.providerThreadId)?.count ===
              unit.count("provider_turns"),
          ),
        "independent synthetic units lost or reused provider turns",
      );
      report.measurements.push({
        phase: "generation-native-identities",
        distinct: providerTurns.length,
        counts: providerTurns.map((row) => row.count),
      });
      report.measurements.push({
        phase: "generation",
        units: sourceUnits.map((unit) => ({
          name: unit.shape.name,
          projectId: unit.projectId,
          workspaceRoot: unit.workspaceRoot,
          rows: unit.sourceRows,
          bytes: unit.sourceBytes,
          tables: unit.sourceTotals,
          assets: unit.assets.length,
        })),
      });
      completedStages.add("generation");
      let forkRoot: string | undefined;
      if (peers) {
        let parent = sourceUnits[0]!.root;
        let run = sourceUnits[0]!.id(
          "runs",
          Math.max(1, Math.floor(sourceUnits[0]!.count("runs") * 0.65)) - 1,
        );
        for (let depth = 1; depth <= 2; depth++) {
          const thread = "thread:bench:run-fork:" + depth;
          yield* owner.source.apply(
            "thread.created",
            thread,
            sourceThread(thread, {
              createdAt: "2026-10-02T00:00:00.000Z",
              lineage: {
                rootThreadId: sourceUnits[0]!.root,
                parentThreadId: parent,
                relationshipToParent: "fork",
              },
              forkedFrom: { type: "run", threadId: parent, runId: run },
            }),
          );
          run = "run:bench:run-fork:" + depth;
          yield* owner.source.apply(
            "run.created",
            thread,
            sourceRun(run, thread, { rootNodeId: "node:" + run, userMessageId: "message:" + run }),
          );
          yield* owner.source.apply("node.updated", thread, {
            id: "node:" + run,
            threadId: thread,
            runId: run,
            parentNodeId: null,
            rootNodeId: "node:" + run,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: FIXTURE_TIME,
            completedAt: FIXTURE_TIME,
          });
          yield* owner.source.apply("message.updated", thread, {
            id: "message:" + run,
            threadId: thread,
            runId: run,
            nodeId: "node:" + run,
            createdBy: "user",
            creationSource: "web",
            role: "user",
            text: "Synthetic fork request",
            attachments: [],
            streaming: false,
            createdAt: FIXTURE_TIME,
            updatedAt: FIXTURE_TIME,
          });
          const itemRows = depth === 2 && !small ? 7400 : 1;
          for (let index = 0; index < itemRows; index++) {
            const item = "item:bench:run-fork:" + depth + ":" + index;
            yield* owner.source.apply(
              "turn-item.updated",
              thread,
              sourceItem(item, thread, {
                runId: run,
                nodeId: "node:" + run,
                messageId: "message:" + run,
                ordinal: index + 1,
                text: "The synthetic fork marker is indigo. Complete owned fork history " + index,
              }),
            );
            yield* owner.source
              .sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id,turn_item_id,ordinal) VALUES (${thread},${item},${index + 1})`;
          }
          yield* owner.source
            .sql`INSERT INTO mcp_app_model_context (thread_id,item_id,server,tool,text,updated_at) VALUES (${thread},${sourceUnits[0]!.id("turn_items", 0)},'synthetic-server','synthetic-tool',${"Complete inherited context é 工具 " + depth},${FIXTURE_TIME})`;
          report.measurements.push({
            phase: "run-fork-shape",
            depth,
            ownTurnItems: itemRows,
            sourceRows: 4 + itemRows * 2,
          });
          parent = thread;
        }
        forkRoot = parent;
      }
      const referenceKey = (id: string): UnitKey | undefined => {
        const unit = sourceUnits.find((unit) => id.includes(":" + unit.tag + ":"));
        if (unit) return ["environment:synthetic-t3", unit.root, 1];
        for (const depth of [1, 2])
          if (id.includes(":run-fork:" + depth))
            return ["environment:synthetic-t3", "thread:bench:run-fork:" + depth, 1];
        return undefined;
      };
      const snapshotPrediction = (yield* sourceByteCount(owner.source)) * 5 + 64 * 1024 ** 2;
      for (let repetition = 0; repetition < (small ? 1 : 3); repetition++)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const benchScope = yield* Scope.Scope;
            const queue = yield* Queue.unbounded<string>();
            const sent = new Set<string>();
            let h: Effect.Success<ReturnType<typeof harness>>;
            const phaseHolds: Array<{
              root: string;
              milliseconds: number;
              p99: number;
              publicationMs: number;
            }> = [];
            const storage = new Map<
              string,
              { stop: ReturnType<typeof watchStorage>; prediction: number }
            >();
            const phaseOffsets = new Map<string, { offset: number; start: number }>();
            const readers: Array<Effect.Success<ReturnType<typeof peer>>> = [];
            const hooks = {
              milestone: (stage: string, root: string) =>
                Effect.gen(function* () {
                  if (stage === "after-unit-staging") {
                    const filename = findStage(h.config.stateDir)!;
                    const ledger = yield* Effect.scoped(
                      Effect.gen(function* () {
                        const sql = Context.get(
                          yield* Layer.build(
                            NodeSqliteClient.layer({
                              filename,
                              readonly: true,
                              writerWorker: true,
                              checkpointWorker: false,
                            }),
                          ),
                          SqlClient.SqlClient,
                        );
                        const encoded = yield* sql<{
                          tbl: string;
                          bytes: number;
                        }>`SELECT tbl,bytes FROM t3i_encoded_bytes`;
                        const result: Array<Record<string, unknown>> = [];
                        for (const table of SOURCE_TABLES) {
                          const name = sourceTableName(table);
                          const columns = yield* sql<{
                            name: string;
                          }>`SELECT name FROM pragma_table_xinfo(${name}) WHERE hidden=0`;
                          const stored = yield* sql.unsafe<{ rows: number; bytes: number }>(
                            `SELECT COUNT(*) AS rows,COALESCE(SUM(${rowBytesSql(columns.map((column) => column.name))}),0) AS bytes FROM ${quoteIdentifier(name)}`,
                          );
                          result.push({
                            table: name,
                            mappedEncodedBytes: encoded.find((row) => row.tbl === name)?.bytes ?? 0,
                            stored: stored[0],
                          });
                        }
                        return result;
                      }),
                    ).pipe(Effect.orDie);
                    report.measurements.push({ phase: "mapped-stored-ledger", root, ledger });
                    const size = NodeFS.statSync(filename).size;
                    storage.set(root, {
                      stop: watchStorage(h.config.stateDir),
                      prediction: size * 5 + 64 * 1024 ** 2,
                    });
                  }
                  if (stage === "after-unit-staging" && peers)
                    readers.push(
                      yield* peer("reader", h.config.dbPath).pipe(
                        Effect.provideService(Scope.Scope, benchScope),
                      ),
                    );
                  if (stage === "before-commit") {
                    phaseOffsets.set(root, { offset: timings.length, start: now() });
                    loop.reset();
                  }
                  if (stage === "mid-bulk" && peers && !sent.has(root)) {
                    sent.add(root);
                    yield* Queue.offer(queue, root);
                  }
                  if (stage === "after-commit") {
                    const tracked = storage.get(root)!;
                    const actual = tracked.stop();
                    storage.delete(root);
                    report.measurements.push({
                      phase: "destination-storage",
                      root,
                      prediction: tracked.prediction,
                      ...actual,
                    });
                    gate(
                      tracked.prediction >= actual.growth,
                      "destination storage prediction was below observed peak",
                    );
                    const phase = phaseOffsets.get(root)!;
                    const tx = timings
                      .slice(phase.offset)
                      .filter((t) => t.filename === h.config.dbPath);
                    const begin = tx.find((t) => /^BEGIN IMMEDIATE/i.test(t.sql));
                    const commit = tx.findLast((t) => /^COMMIT/i.test(t.sql));
                    phaseHolds.push({
                      root,
                      milliseconds:
                        begin && commit ? commit.milliseconds - begin.milliseconds : Infinity,
                      p99: loop.percentile(99) / 1e6,
                      publicationMs: commit
                        ? now() - phase.start - (commit.milliseconds - begin!.milliseconds)
                        : Infinity,
                    });
                  }
                }),
            };
            h = yield* harness(undefined, 81).pipe(
              Effect.provideService(T3ImportService.ImportHooks, hooks),
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const tracked of storage.values()) tracked.stop();
              }),
            );
            if (peers) yield* prefill(h, owner.source);
            yield* h.sql`CREATE TABLE bench_external_writer(value INTEGER)`;
            const sentinel = C.ThreadId.make("thread:bench:sentinel");
            yield* h.store.apply(
              yield* decodeEvent({
                id: "event:bench:sentinel",
                type: "thread.created",
                threadId: sentinel,
                occurredAt: FIXTURE_TIME,
                payload: sourceThread(sentinel),
              }),
            );
            const writes: Array<{ root: string; milliseconds: number; publicationMs: number }> = [];
            const writing = !peers
              ? undefined
              : yield* Effect.gen(function* () {
                  for (let i = 0; i < sourceUnits.length; i++) {
                    const root = yield* Queue.take(queue);
                    const start = now();
                    yield* h.sql`INSERT INTO bench_external_writer VALUES (-1)`;
                    const milliseconds = now() - start;
                    const thread = yield* h.store.getThread(sentinel);
                    const pub = now();
                    yield* h.sink.write({
                      events: [
                        {
                          id: C.EventId.make("event:bench:publication:" + repetition + ":" + i),
                          type: "thread.metadata-updated",
                          threadId: sentinel,
                          occurredAt: DateTime.nowUnsafe(),
                          payload: { ...thread, title: "Competing publication " + i },
                        },
                      ],
                    });
                    writes.push({ root, milliseconds, publicationMs: now() - pub });
                  }
                }).pipe(Effect.forkScoped);
            const before = process.memoryUsage();
            loop.enable();
            const stopSnapshot = watchStorage(h.config.stateDir);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                stopSnapshot();
              }),
            );
            const openedAt = now();
            const { sessionId } = yield* h.importer.open({ sourceHome: owner.source.home });
            yield* h.importer.awaitReady(sessionId);
            const snapshotStorage = stopSnapshot();
            report.measurements.push({
              phase: "snapshot-storage",
              prediction: snapshotPrediction,
              ...snapshotStorage,
            });
            gate(
              snapshotPrediction >= snapshotStorage.growth,
              "snapshot storage prediction was below observed peak",
            );
            report.measurements.push({ phase: "snapshot", milliseconds: now() - openedAt });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const snapshot = findStage(h.config.stateDir, "snapshot.sqlite");
                gate(
                  snapshot !== undefined,
                  "staged source snapshot missing for eligibility proof",
                );
                const snapshotSql = Context.get(
                  yield* Layer.build(
                    NodeSqliteClient.layer({
                      filename: snapshot!,
                      readonly: true,
                      writerWorker: true,
                      checkpointWorker: false,
                    }),
                  ),
                  SqlClient.SqlClient,
                );
                const projections = Context.get(
                  yield* Layer.build(
                    ProjectionStore.layer.pipe(
                      Layer.provide(Layer.succeed(SqlClient.SqlClient, snapshotSql)),
                    ),
                  ),
                  ProjectionStore.ProjectionStoreV2,
                );
                for (const instant of [FIXTURE_TIME, "9999-12-31T00:00:00Z"]) {
                  const candidates = yield* projections.findWorkCandidates(
                    sourceUnits.flatMap((unit) => unit.members.map((id) => C.ThreadId.make(id))),
                    { now: DateTime.makeUnsafe(instant) },
                  );
                  report.measurements.push({
                    phase: "staged-source-eligibility",
                    repetition,
                    instant,
                    candidates,
                  });
                  gate(
                    candidates.length === 0,
                    "synthetic completed unit has recoverable staged-source work",
                  );
                }
              }),
            );
            let preview: Effect.Success<ReturnType<typeof h.importer.preview>> | undefined;
            for (
              let previewRepetition = 0;
              previewRepetition < (small ? 1 : 3);
              previewRepetition++
            ) {
              const started = now();
              loop.reset();
              preview = yield* h.importer.preview({
                sessionId,
                selection: selection(sourceUnits.map((unit) => unit.root)),
              });
              const milliseconds = now() - started;
              const delay = { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
              report.measurements.push({
                phase: "preview",
                repetition,
                previewRepetition,
                milliseconds,
                delay,
                totals: preview.totals,
                blocked: preview.sections.blocked.rows,
              });
              gate(
                preview.sections.blocked.rows.length === 0,
                "required complete core unit blocked during preview",
              );
              if (!small) {
                gate(milliseconds <= 30000, "core preview exceeded 30 seconds");
                gate(delay.p99 <= 50 && delay.max <= 250, "preview event-loop gate failed");
              }
            }
            const writer = !peers ? undefined : yield* peer("writer", h.config.dbPath);
            const started = now();
            loop.reset();
            const { jobId } = yield* h.importer.start({ sessionId, planId: preview!.planId });
            const startMs = now() - started;
            report.measurements.push({ phase: "start", milliseconds: startMs });
            if (!small) gate(startMs <= 30000, "core start exceeded 30 seconds");
            yield* h.importer.awaitJob(jobId);
            const job = yield* allJob(h.importer, jobId);
            const commitMs = now() - started - startMs;
            if (writing) yield* Fiber.join(writing);
            if (writer) {
              writer.child.stdin.end("stop\n");
              yield* Effect.promise(() => writer.closed);
            }
            for (const reader of readers) yield* Effect.promise(() => reader.closed);
            const after = process.memoryUsage();
            report.measurements.push({
              phase: "contention",
              repetition,
              holds: [...phaseHolds],
              writes,
              external: writer?.messages,
            });
            if (!small) {
              gate(
                phaseHolds.length === sourceUnits.length &&
                  phaseHolds.every((hold) => hold.milliseconds <= 1500 && hold.p99 <= 20),
                "representative phase F hold or event-loop gate failed",
              );
              const maximum = Math.max(...phaseHolds.map((hold) => hold.milliseconds));
              gate(
                writes.length === sourceUnits.length &&
                  writes.every((write) => write.milliseconds <= maximum + 100),
                "in-process writer wait gate failed",
              );
              const external = writer!.messages.find((m) => m.type === "done")?.writes as
                | Array<{ milliseconds: number; busy: boolean }>
                | undefined;
              gate(
                !!external?.length &&
                  external.every((write) => !write.busy && write.milliseconds <= maximum + 250),
                "external writer busy or latency gate failed",
              );
            }
            report.measurements.push({
              phase: "commit",
              milliseconds: commitMs,
              job,
              heapDelta: after.heapUsed - before.heapUsed,
              rssDelta: after.rss - before.rss,
              eventLoop: { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
            });
            gate(
              job.status === "completed" &&
                job.results.every((unit) => unit.outcome === "imported"),
              "complete core import did not commit all units",
            );
            if (!small) {
              gate(commitMs <= 120000, "core commit exceeded 120 seconds");
              gate(
                after.heapUsed - before.heapUsed <= 512 * 1024 ** 2,
                "core heap delta exceeded 512 MiB",
              );
              gate(after.rss - before.rss <= 1024 ** 3, "core RSS delta exceeded 1 GiB");
            }
            for (const unit of sourceUnits)
              yield* verifyUnit(h, owner.source, unit, owner.directory, peers, referenceKey);
            yield* h.sql`PRAGMA wal_checkpoint(TRUNCATE)`;
            const wal = yield* Effect.promise(() =>
              NodeFSP.stat(h.config.dbPath + "-wal").then(
                (stat) => stat.size,
                () => 0,
              ),
            );
            gate(wal <= 128 * 1024 ** 2, "WAL remained above 128 MiB after unpinned checkpoint");
            const countMismatch =
              yield* h.sql`SELECT counts.thread_id FROM orchestration_v2_projection_turn_item_counts counts WHERE counts.item_count <> (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items items WHERE items.thread_id=counts.thread_id AND COALESCE(items.run_id,'')=counts.run_key) LIMIT 1`;
            gate(countMismatch.length === 0, "turn item count trigger fidelity mismatch");
            const repeated = yield* h.importer.preview({
              sessionId,
              selection: selection(sourceUnits.map((unit) => unit.root)),
            });
            report.measurements.push({ phase: "repeat", totals: repeated.totals });
            gate(
              repeated.totals.importing === 0 && repeated.totals.skipped === sourceUnits.length,
              "exact repeat failed to recognize all complete units",
            );
            if (peers && repetition === 0) {
              yield* continuation(
                h,
                destinationId(sourceUnits[0]!.root, [
                  "environment:synthetic-t3",
                  sourceUnits[0]!.root,
                  1,
                ]),
              );
              yield* h.importer.close({ sessionId });
              const opened = yield* h.importer.open({ sourceHome: owner.source.home });
              yield* h.importer.awaitReady(opened.sessionId);
              const forkPlan = yield* h.importer.preview({
                sessionId: opened.sessionId,
                selection: selection([forkRoot!]),
              });
              const forkJob = yield* h.importer.start({
                sessionId: opened.sessionId,
                planId: forkPlan.planId,
              });
              yield* h.importer.awaitJob(forkJob.jobId);
              const forkResult = yield* allJob(h.importer, forkJob.jobId);
              report.measurements.push({
                phase: "run-fork-dependencies",
                totals: forkPlan.totals,
                blocked: forkPlan.sections.blocked.rows,
                result: forkResult,
              });
              gate(
                forkResult.results.every((result) =>
                  ["imported", "skipped"].includes(result.outcome),
                ),
                "large run-fork dependency import failed",
              );
              for (const depth of [1, 2])
                yield* verifyUnit(
                  h,
                  owner.source,
                  {
                    root: "thread:bench:run-fork:" + depth,
                    members: ["thread:bench:run-fork:" + depth],
                    shape: { name: "run-fork:" + depth },
                    assets: [],
                  },
                  owner.directory,
                  peers,
                  referenceKey,
                );
              yield* continuation(
                h,
                destinationId(forkRoot!, ["environment:synthetic-t3", forkRoot!, 1]),
              );
            }
            completedStages.add("representative-repetition-" + repetition);
          }),
        );
    }),
  );
  if (!small || smallCaps) {
    yield* capScenarios();
    if (!small) yield* focusedProofs();
  }
});
try {
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
} catch (error) {
  if (!report.failures.length) report.failures.push(String(error));
  report.diagnostics.push(
    NodeUtil.inspect(error, { depth: 8, maxArrayLength: 12, maxStringLength: 512 }).slice(0, 8192),
  );
} finally {
  loop.disable();
  Object.assign(workers, { Worker: OriginalWorker });
  NodeModule.syncBuiltinESMExports();
  report.finishedUTC = utc();
  report.notRun = [
    "representative-repetition-0",
    "representative-repetition-1",
    "representative-repetition-2",
    "cap",
    "singleton",
    "dense-short-multilingual",
    "focused-proofs",
  ].filter((stage) => !completedStages.has(stage));
  if (!small && report.notRun.length)
    report.failures.push(
      "required benchmark stages did not complete; all hard gates are not satisfied",
    );
  const serialized = encodeJson(report) + "\n";
  if (output) await NodeFSP.writeFile(output, serialized, { mode: 0o600 });
  else process.stdout.write(serialized);
}
process.exitCode = report.failures.length ? 1 : 0;
