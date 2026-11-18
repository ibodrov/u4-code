// @effect-diagnostics nodeBuiltinImport:off
// Synthetic server layers always use a private temporary home.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as Runtime from "../../../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Enrichment from "../../../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as T3ImportService from "../T3ImportService.ts";
import * as T3ImportStaging from "../T3ImportStaging.ts";
import {
  createSource,
  sourceThread,
  sourceItem,
  sourceRun,
  FIXTURE_TIME,
} from "./T3SourceFixture.ts";

export const selection = (ids: string[]): C.T3ImportSelection => ({
  threadIds: ids.map((id) => C.ThreadId.make(id)),
  projectIds: [],
  excludeThreadIds: [],
  newCopyUnitRootIds: [],
  projectMapping: [],
});
export const harness = Effect.fn("T3ImportTest.harness")(function* (
  maxRuntimeMode?: C.RuntimeMode,
  sourceHead = 89,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-t3-import-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const source = yield* createSource(directory, sourceHead);
  const configContext = yield* Layer.build(
    Config.layerTest(directory, NodePath.join(directory, "destination")),
  );
  const config = Context.get(configContext, Config.ServerConfig);
  const db = Sqlite.layerFromPath(config.dbPath);
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(db),
  );
  const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
  const projectService = Runtime.layerProjectService.pipe(Layer.provide(sink));
  const dependencies = Layer.mergeAll(sink, projectService, T3ImportStaging.layer);
  const layer = dependencies.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Config.ServerConfig, config),
        ServerSettings.layerTest(
          {},
          maxRuntimeMode
            ? { organization: "Synthetic policy", lockedSettings: [], limits: { maxRuntimeMode } }
            : undefined,
        ),
        ThreadCommandExecutor.layer,
        WorkspacePaths.layer,
        Layer.mock(Enrichment.ProjectEnrichmentService)({
          invalidate: () => Effect.void,
          request: () => Effect.void,
          peek: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(C.EnvironmentId.make("environment:synthetic-u4")),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(layer);
  const newImporter = (scope: Scope.Closeable) =>
    Layer.build(T3ImportService.layer).pipe(
      Effect.provide(context),
      Effect.provideService(Scope.Scope, scope),
      Effect.map((context) => Context.get(context, T3ImportService.T3ImportService)),
    );
  const importerScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(importerScope, Exit.void));
  const importer = yield* newImporter(importerScope);
  return {
    directory,
    config,
    source,
    importer,
    importerScope,
    newImporter,
    sql: Context.get(context, SqlClient.SqlClient),
    sink: Context.get(context, EventSink.EventSinkV2),
    settings: Context.get(context, ServerSettings.ServerSettingsService),
    store: Context.get(context, ProjectionStore.ProjectionStoreV2),
  };
});
export const importSelection = Effect.fn("T3ImportTest.importSelection")(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  ids: string[],
) {
  const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
  yield* h.importer.awaitReady(sessionId);
  const preview = yield* h.importer.preview({ sessionId, selection: selection(ids) });
  NodeAssert.deepStrictEqual(preview.sections.blocked.rows, []);
  const { jobId } = yield* h.importer.start({ sessionId, planId: preview.planId });
  yield* h.importer.awaitJob(jobId);
  return { sessionId, preview, result: yield* h.importer.getJob({ jobId }) };
});

export const goldenSource = Effect.fn("T3ImportTest.goldenSource")(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
) {
  yield* h.source.sql`UPDATE projection_projects SET workspace_root = '/tmp'`;
  const root = "3f2a6b1c-7e8d-4a9b-8c0d-1e2f3a4b5c6d";
  const child = "thread:golden:child";
  const fork = "thread:golden:fork";
  yield* h.source.apply("thread.created", root, sourceThread(root));
  yield* h.source.apply(
    "thread.created",
    child,
    sourceThread(child, {
      lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "subagent" },
      forkedFrom: { type: "node", threadId: root, nodeId: "node:root" },
    }),
  );
  yield* h.source.apply(
    "thread.created",
    fork,
    sourceThread(fork, {
      lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "fork" },
      forkedFrom: { type: "run", threadId: root, runId: "run:root" },
    }),
  );
  yield* h.source.apply(
    "run.created",
    root,
    sourceRun("run:root", root, { rootNodeId: "node:root", activeAttemptId: "attempt:root" }),
  );
  yield* h.source.apply("run-attempt.created", root, {
    id: "attempt:root",
    runId: "run:root",
    attemptOrdinal: 1,
    rootNodeId: "node:root",
    providerInstanceId: "codex",
    providerThreadId: "provider-thread:source",
    providerTurnId: "provider-turn:root",
    reason: "initial",
    status: "completed",
    startedAt: FIXTURE_TIME,
    completedAt: FIXTURE_TIME,
  });
  yield* h.source.apply("node.updated", root, {
    id: "node:root",
    threadId: root,
    runId: "run:root",
    parentNodeId: null,
    rootNodeId: "node:root",
    kind: "root_turn",
    status: "completed",
    countsForRun: true,
    providerThreadId: "provider-thread:source",
    providerTurnId: "provider-turn:root",
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: FIXTURE_TIME,
    completedAt: FIXTURE_TIME,
  });
  yield* h.source.apply("subagent.updated", root, {
    id: "subagent:root",
    threadId: root,
    runId: "run:root",
    parentNodeId: "node:root",
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: child,
    nativeTaskRef: null,
    prompt: "Full prompt é\n工具",
    title: "Child",
    model: null,
    status: "completed",
    result: "Full result",
    startedAt: FIXTURE_TIME,
    completedAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  });
  yield* h.source.apply("provider-turn.updated", root, {
    id: "provider-turn:root",
    providerThreadId: "provider-thread:source",
    nodeId: "node:root",
    runAttemptId: "attempt:root",
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: FIXTURE_TIME,
    completedAt: FIXTURE_TIME,
  });
  yield* h.source.apply("runtime-request.updated", root, {
    id: "request:root",
    nodeId: "node:root",
    providerTurnId: "provider-turn:root",
    nativeRequestRef: null,
    kind: "user_input",
    status: "resolved",
    responseCapability: { type: "message" },
    createdAt: FIXTURE_TIME,
    resolvedAt: FIXTURE_TIME,
  });
  yield* h.source.apply("plan.updated", root, {
    id: "plan:root",
    threadId: root,
    runId: "run:root",
    nodeId: "node:root",
    status: "completed",
    kind: "proposed_plan",
    markdown: "Complete plan text",
  });
  const assetId = "legacy-11111111-1111-4111-8111-111111111111-pdf";
  const attachment = {
    type: "file",
    id: assetId,
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 8,
  };
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(h.source.userdata, "attachments", assetId + ".pdf"),
      "%PDF-T3\n",
    ),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(h.source.userdata, "attachments", assetId + ".pdf.txt"),
      "All extracted text\n",
    ),
  );
  for (const [owner, item, ordinal] of [
    [root, "item:Z", 4],
    [root, "item:a", 8],
    [child, "item:child", 2],
    [fork, "item:fork", 1],
  ] as const) {
    yield* h.source.apply("message.updated", owner, {
      id: "message:" + item,
      threadId: owner,
      runId: owner === root ? "run:root" : null,
      nodeId: null,
      createdBy: "user",
      creationSource: "web",
      role: "assistant",
      text: "Complete text " + item + " é 工具\n",
      attachments: owner === root ? [attachment] : [],
      streaming: false,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    });
    yield* h.source.apply(
      "turn-item.updated",
      owner,
      sourceItem(item, owner, {
        runId: owner === root ? "run:root" : null,
        ordinal,
        text: "Complete text " + item + " é 工具\n",
        attachments: owner === root ? [attachment] : [],
      }),
    );
  }
  yield* h.source.apply("context-transfer.created", fork, {
    id: "transfer:fork",
    type: "fork",
    sourceThreadId: root,
    targetThreadId: fork,
    sourcePoint: { threadId: root, runId: "run:root" },
    basePoint: null,
    sourceProviderInstanceId: "codex",
    targetProviderInstanceId: "codex",
    targetRunId: null,
    status: "consumed",
    resolution: {
      strategy: "native_fork",
      providerThreadRef: { driver: "codex", nativeId: "old", strength: "strong" },
    },
    createdBy: "user",
    error: null,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    consumedAt: FIXTURE_TIME,
  });
  yield* h.source
    .sql`INSERT INTO mcp_app_model_context VALUES (${fork}, 'item:Z', 'server', 'tool', 'Full context é 工具', ${FIXTURE_TIME})`;
  return { root, child, fork };
});
