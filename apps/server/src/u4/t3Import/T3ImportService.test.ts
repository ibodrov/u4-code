// @effect-diagnostics nodeBuiltinImport:off
// All source and destination databases are synthetic, private temporary homes.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as McpAppModelContext from "../../mcpApps/McpAppModelContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Statement from "effect/sql/Statement";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { harness, selection, importSelection, goldenSource } from "./testkit/T3ImportHarness.ts";
import * as T3ImportService from "./T3ImportService.ts";
import * as T3ImportStaging from "./T3ImportStaging.ts";
import { sourceThread, sourceItem, sourceRun, FIXTURE_TIME } from "./testkit/T3SourceFixture.ts";
import {
  IMPORT_LIMITS,
  ImportLimits,
  destinationId,
  digest,
  type UnitKey,
  RECORD_TABLES,
  PROJECTION_PREFIX,
} from "./t3ImportPlan.ts";
import { historicalMessage, selectHistory } from "@t3tools/provider-core/server/handoffBudget";
import { verifyImportedRecord } from "./testkit/ImportFidelity.ts";
import * as Publisher from "./T3ImportPublisher.ts";
import { toolAssetId } from "./t3ImportAssets.ts";
import {
  attachmentRelativePath,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

it.effect(
  "imports durable inert history, creates only project metadata, and recognizes an exact repeat after reopen",
  () =>
    Effect.gen(function* () {
      let h: Effect.Success<ReturnType<typeof harness>>;
      h = yield* harness().pipe(
        Effect.provideService(T3ImportService.ImportHooks, {
          milestone: (stage) =>
            stage === "after-unit-staging"
              ? h.sql`SELECT 1 FROM orchestration_v2_projection_threads`.pipe(
                  Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 0))),
                  Effect.asVoid,
                  Effect.orDie,
                )
              : Effect.void,
        }),
      );
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply("turn-item.updated", "thread:a", sourceItem("item:a", "thread:a"));
      const memoMap = yield* Layer.makeMemoMap;
      yield* Layer.buildWithMemoMap(
        ProjectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, h.sql))),
        memoMap,
        yield* Effect.scope,
      );
      const imported = yield* importSelection(h, ["thread:a"]).pipe(
        Effect.provideService(Layer.CurrentMemoMap, memoMap),
      );
      assert.deepStrictEqual(
        imported.result.results.map((r) => [r.outcome, r.reason]),
        [["imported", "imported"]],
      );
      const id = C.ThreadId.make(
        destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 1]),
      );
      const thread = yield* h.store.getThread(id);
      assert.strictEqual(thread.branch, null);
      assert.strictEqual(thread.worktreePath, null);
      assert.strictEqual(thread.activeProviderThreadId, null);
      assert.deepStrictEqual(thread.importedFrom?.ownedTransferIds, []);
      assert.strictEqual(thread.importedFrom?.threadId, "thread:a");
      const snapshot = yield* h.store.getThreadSnapshotWindow(id, { rowLimit: 500 });
      assert.ok(
        snapshot.projection.visibleTurnItems.some((row) => row.item.type === "system_notice"),
      );
      for (const now of [
        DateTime.makeUnsafe(FIXTURE_TIME),
        DateTime.makeUnsafe("9999-12-31T00:00:00Z"),
      ])
        assert.deepStrictEqual(yield* h.store.findWorkCandidates([id], { now }), []);
      for (const table of [
        "orchestration_v2_projection_provider_threads",
        "orchestration_v2_projection_provider_sessions",
        "orchestration_v2_effect_outbox",
        "orchestration_v2_command_receipts",
      ])
        assert.strictEqual((yield* h.sql.unsafe(`SELECT 1 FROM ${table}`)).length, 0);
      const events = yield* h.sql<{
        readonly event_type: string;
      }>`SELECT event_type FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread'`;
      assert.deepStrictEqual(
        events.map((e) => e.event_type),
        ["thread.created"],
      );
      yield* h.importer.close({ sessionId: imported.sessionId });
      const repeat = yield* importSelection(h, ["thread:a"]);
      assert.strictEqual(repeat.preview.totals.importing, 0);
      assert.strictEqual(repeat.result.results[0]?.reason, "already-imported");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps fork transfer ownership immutable when only the ancestor receives a new generation (R1)",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply("run.created", "thread:a", sourceRun("run:a", "thread:a"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("item:a", "thread:a", { runId: "run:a" }),
      );
      yield* h.source.apply(
        "thread.created",
        "thread:b",
        sourceThread("thread:b", {
          lineage: {
            rootThreadId: "thread:a",
            parentThreadId: "thread:a",
            relationshipToParent: "fork",
          },
          forkedFrom: { type: "run", threadId: "thread:a", runId: "run:a" },
        }),
      );
      yield* h.source.apply("context-transfer.created", "thread:b", {
        id: "transfer:fork",
        type: "fork",
        sourceThreadId: "thread:a",
        targetThreadId: "thread:b",
        sourcePoint: { threadId: "thread:a", runId: "run:a" },
        basePoint: null,
        sourceProviderInstanceId: "codex",
        targetProviderInstanceId: "codex",
        targetRunId: null,
        status: "consumed",
        resolution: {
          strategy: "native_fork",
          providerThreadRef: { driver: "codex", nativeId: "source-native", strength: "strong" },
        },
        createdBy: "user",
        error: null,
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
        consumedAt: FIXTURE_TIME,
      });
      const first = yield* importSelection(h, ["thread:a", "thread:b"]);
      assert.deepStrictEqual(
        first.result.results.map((r) => r.outcome),
        ["imported", "imported"],
      );
      const a1 = C.ThreadId.make(
        destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 1]),
      );
      const b1 = C.ThreadId.make(
        destinationId("thread:b", ["environment:synthetic-t3", "thread:b", 1]),
      );
      assert.deepStrictEqual((yield* h.store.getThread(a1)).importedFrom?.ownedTransferIds, []);
      assert.strictEqual((yield* h.store.getThread(b1)).importedFrom?.ownedTransferIds?.length, 1);
      const preserved =
        yield* h.sql`SELECT payload_json FROM orchestration_v2_projection_context_transfers`;
      const bBefore =
        yield* h.sql`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${b1}`;
      const repeated = yield* h.importer.preview({
        sessionId: first.sessionId,
        selection: selection(["thread:a"]),
      });
      assert.strictEqual(repeated.sections.threads.rows[0]?.category, "already-imported");
      yield* h.importer.close({ sessionId: first.sessionId });
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("item:a", "thread:a", { runId: "run:a", text: "Changed ancestor" }),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      yield* h.importer.awaitReady(sessionId);
      const changed = {
        ...selection(["thread:a"]),
        newCopyUnitRootIds: [C.ThreadId.make("thread:a")],
      };
      const plan = yield* h.importer.preview({ sessionId, selection: changed });
      assert.deepStrictEqual(plan.sections.blocked.rows, []);
      assert.deepStrictEqual(plan.sections.dependencies.rows, []);
      const { jobId } = yield* h.importer.start({ sessionId, planId: plan.planId });
      yield* h.importer.awaitJob(jobId);
      assert.strictEqual((yield* h.importer.getJob({ jobId })).results[0]?.outcome, "imported");
      const a2 = C.ThreadId.make(
        destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 2]),
      );
      assert.deepStrictEqual((yield* h.store.getThread(a2)).importedFrom?.ownedTransferIds, []);
      assert.deepStrictEqual(
        yield* h.sql`SELECT payload_json FROM orchestration_v2_projection_context_transfers`,
        preserved,
      );
      assert.deepStrictEqual(
        yield* h.sql`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${b1}`,
        bBefore,
      );
      assert.ok(
        (yield* h.store.getThreadProjection(b1)).visibleTurnItems.some(
          (r) => r.item.type === "assistant_message",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "imports message-only legacy PDFs using metadata bytes and a canonical ID reachable by both readers (R3)",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const sourceThreadId = "3f2a6b1c-7e8d-4a9b-8c0d-1e2f3a4b5c6d";
      const sourceMessageId = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
      const sourceId = "legacy-11111111-1111-4111-8111-111111111111";
      const attachment = {
        type: "file",
        id: sourceId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };
      const bytes = Buffer.from("%PDF-T3\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(h.source.userdata, "attachments", sourceId + ".pdf"),
          bytes,
        ),
      );
      yield* h.source.apply("thread.created", sourceThreadId, sourceThread(sourceThreadId));
      yield* h.source.apply("message.updated", sourceThreadId, {
        id: sourceMessageId,
        threadId: sourceThreadId,
        runId: null,
        nodeId: null,
        createdBy: "user",
        creationSource: "web",
        role: "assistant",
        text: "Report",
        attachments: [attachment],
        streaming: false,
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
      });
      yield* h.source.apply(
        "turn-item.updated",
        sourceThreadId,
        sourceItem("item:a", sourceThreadId, {
          messageId: sourceMessageId,
          attachments: [attachment],
        }),
      );
      const imported = yield* importSelection(h, [sourceThreadId]);
      assert.strictEqual(imported.result.results[0]?.outcome, "imported");
      assert.ok(
        imported.preview.sections.warnings.rows.some((r) => r.category === "message-path-only"),
      );
      assert.ok(
        imported.preview.sections.warnings.rows.some(
          (r) => r.category === "legacy-asset-normalized",
        ),
      );
      const threadId = C.ThreadId.make(
        destinationId(sourceThreadId, ["environment:synthetic-t3", sourceThreadId, 1]),
      );
      assert.strictEqual(imported.result.results[0]?.destinationThreadId, threadId);
      const creation = yield* h.sql<{
        readonly stream_id: string;
        readonly projection_id: string;
        readonly payload_id: string;
      }>`SELECT event.stream_id, thread.thread_id AS projection_id,
          json_extract(event.payload_json, '$.id') AS payload_id
        FROM orchestration_events event
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = ${threadId}
        WHERE event.event_type = 'thread.created' AND event.application_event_version = 2`;
      assert.deepStrictEqual(
        creation.map((row) => [row.stream_id, row.projection_id, row.payload_id]),
        [[threadId, threadId, threadId]],
      );
      assert.ok(yield* h.store.getThreadShell(threadId));
      const projection = yield* h.store.getThreadProjection(threadId);
      assert.strictEqual(
        projection.messages[0]?.id,
        destinationId(sourceMessageId, ["environment:synthetic-t3", sourceThreadId, 1]),
      );
      const copied = projection.messages[0]!.attachments[0]!;
      assert.strictEqual(
        parseThreadSegmentFromAttachmentId(copied.id),
        toSafeThreadAttachmentSegment(threadId),
      );
      assert.strictEqual(copied.name, attachment.name);
      assert.strictEqual(copied.mimeType, attachment.mimeType);
      assert.strictEqual(parseAttachmentFileExtension(copied.id), "pdf");
      const byMessage = resolveAttachmentPath({
        attachmentsDir: h.config.attachmentsDir,
        attachment: copied,
      });
      const byId = resolveAttachmentPathById({
        attachmentsDir: h.config.attachmentsDir,
        attachmentId: copied.id,
      });
      assert.strictEqual(byMessage, byId);
      assert.strictEqual(attachmentRelativePath(copied), copied.id + ".pdf");
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(byMessage!)), bytes);
      assert.ok((yield* h.store.getThreadAttachmentIds(threadId)).includes(copied.id));
      yield* h.importer.close({ sessionId: imported.sessionId });
      for (const suffix of [".pdf", ".pdf.txt"]) {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(h.source.userdata, "attachments", sourceId + suffix),
            suffix === ".pdf" ? "%PDF-N3\n" : "Changed synthetic sidecar",
          ),
        );
        const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
        yield* h.importer.awaitReady(sessionId);
        const changed = yield* h.importer.preview({
          sessionId,
          selection: selection([sourceThreadId]),
        });
        assert.equal(changed.sections.threads.rows[0]?.category, "changed-since-import");
        const next = yield* h.importer.preview({
          sessionId,
          selection: {
            ...selection([sourceThreadId]),
            newCopyUnitRootIds: [C.ThreadId.make(sourceThreadId)],
          },
        });
        assert.equal(next.sections.threads.rows[0]?.generation, 2);
        if (suffix === ".pdf.txt") {
          const started = yield* h.importer.start({ sessionId, planId: next.planId });
          yield* h.importer.awaitJob(started.jobId);
          assert.equal((yield* h.importer.getJob(started)).results[0]?.outcome, "imported");
          const nextThread = C.ThreadId.make(
            destinationId(sourceThreadId, ["environment:synthetic-t3", sourceThreadId, 2]),
          );
          const nextProjection = yield* h.store.getThreadProjection(nextThread);
          const asset = nextProjection.messages[0]!.attachments[0]!;
          assert.equal(
            parseThreadSegmentFromAttachmentId(asset.id),
            toSafeThreadAttachmentSegment(nextThread),
          );
          assert.notEqual(asset.id, copied.id);
          const path = resolveAttachmentPath({
            attachmentsDir: h.config.attachmentsDir,
            attachment: asset,
          })!;
          assert.equal(yield* Effect.promise(() => NodeFSP.readFile(path, "utf8")), "%PDF-N3\n");
          assert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(path + ".txt", "utf8")),
            "Changed synthetic sidecar",
          );
          assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(byMessage!)), bytes);
        }
        yield* h.importer.close({ sessionId });
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "preserves an unknown journal and its inode witnesses on same-server retry, then reconciles absence before a distinct attempt (R2)",
  () =>
    Effect.gen(function* () {
      let phase = "initial",
        allowOutcome = true;
      const attempts: string[] = [];
      let h: Effect.Success<ReturnType<typeof harness>>;
      const hooks = {
        milestone: (stage: string) =>
          Effect.gen(function* () {
            if (stage === "assets-published") {
              const entries = yield* Effect.promise(() => Publisher.listPublications(h.config));
              attempts.push(entries[0]!.attemptId);
              if (phase === "initial") allowOutcome = false;
            }
            if (stage === "before-commit" && phase === "initial")
              return yield* new C.T3ImportError({ reason: "cancelled" });
            if (stage === "outcome" && !allowOutcome)
              return yield* new C.T3ImportError({ reason: "unknown" });
          }),
      };
      h = yield* harness().pipe(Effect.provideService(T3ImportService.ImportHooks, hooks));
      const sourceId = "legacy-11111111-1111-4111-8111-111111111111";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(h.source.userdata, "attachments", sourceId + ".html"),
          "<p>staged</p>",
        ),
      );
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("tool:a", "thread:a", {
          type: "dynamic_tool",
          toolName: "html_render",
          input: {},
          output: { htmlRender: { attachmentId: sourceId + "-html", title: "Page", height: 320 } },
        }),
      );
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(h.source.userdata, "attachments", sourceId + ".html"),
          NodePath.join(h.source.userdata, "attachments", sourceId + "-html.html"),
        ),
      );
      const first = yield* importSelection(h, ["thread:a"]);
      assert.strictEqual(first.result.status, "unknown");
      assert.strictEqual(first.result.results[0]?.reason, "unknown");
      const entries = yield* Effect.promise(() => Publisher.listPublications(h.config));
      assert.strictEqual(entries.length, 1);
      const entry = entries[0]!;
      const journalDir = NodePath.join(h.config.stateDir, "imports", "t3", "journal");
      const journalNames = yield* Effect.promise(() => NodeFSP.readdir(journalDir));
      const journalPath = NodePath.join(journalDir, journalNames[0]!);
      const before = yield* Effect.promise(() => NodeFSP.readFile(journalPath));
      const witness = yield* Effect.promise(() => NodeFSP.lstat(entry.files[0]!.privatePath));
      const finalPath = NodePath.join(h.config.attachmentsDir, entry.files[0]!.finalName);
      const finalBefore = yield* Effect.promise(() => NodeFSP.lstat(finalPath));
      assert.strictEqual(finalBefore.ino, witness.ino);
      const preview = yield* h.importer.preview({
        sessionId: first.sessionId,
        selection: selection(["thread:a"]),
      });
      const refused = yield* h.importer
        .start({ sessionId: first.sessionId, planId: preview.planId })
        .pipe(Effect.result);
      assert.strictEqual(refused._tag, "Failure");
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(journalPath)), before);
      assert.strictEqual(
        (yield* Effect.promise(() => NodeFSP.lstat(entry.files[0]!.privatePath))).ino,
        witness.ino,
      );
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.lstat(finalPath))).ino, witness.ino);
      phase = "retry";
      allowOutcome = true;
      const { jobId } = yield* h.importer.start({
        sessionId: first.sessionId,
        planId: preview.planId,
      });
      yield* h.importer.awaitJob(jobId);
      assert.strictEqual((yield* h.importer.getJob({ jobId })).results[0]?.outcome, "imported");
      assert.strictEqual(attempts.length, 2);
      assert.notStrictEqual(attempts[0], attempts[1]);
      assert.deepStrictEqual(yield* Effect.promise(() => Publisher.listPublications(h.config)), []);
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(finalPath, "utf8")),
        "<p>staged</p>",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([false, true])(
  "keeps a usage-limit failure unarmed at both recovery instants and preserves its historical error (null root=%s)",
  (nullRoot) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply(
        "run.created",
        "thread:a",
        sourceRun("run:a", "thread:a", {
          status: "failed",
          ...(nullRoot ? { rootNodeId: null } : {}),
        }),
      );
      const error: Record<string, unknown> = sourceItem("error:a", "thread:a", {
        type: "error",
        runId: "run:a",
        nodeId: nullRoot ? null : "node:run:a",
        status: "failed",
        failure: {
          class: "usage_limit",
          message: "Synthetic exhausted budget",
          code: null,
          retryable: false,
          resetAt: "2026-12-01T00:00:00.000Z",
        },
      });
      delete error.messageId;
      delete error.text;
      delete error.streaming;
      yield* h.source.apply("turn-item.updated", "thread:a", error);
      const imported = yield* importSelection(h, ["thread:a"]);
      const id = imported.result.results[0]!.destinationThreadId!;
      const thread = yield* h.store.getThread(id);
      assert.strictEqual(thread.limitRecovery?.autoResume, false);
      assert.strictEqual(
        thread.limitRecovery?.runId,
        destinationId("run:a", ["environment:synthetic-t3", "thread:a", 1]),
      );
      for (const now of [
        DateTime.makeUnsafe(FIXTURE_TIME),
        DateTime.makeUnsafe("9999-12-31T00:00:00Z"),
      ])
        assert.deepStrictEqual(yield* h.store.findWorkCandidates([id], { now }), []);
      const projection = yield* h.store.getThreadProjection(id);
      assert.ok(
        projection.turnItems.some(
          (item) => item.type === "error" && item.failure.message === "Synthetic exhausted budget",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["link", "secret", "request", "subagent-result"] as const)(
  "blocks pending %s independently of completed run state and reports partial results",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      if (kind === "subagent-result") {
        yield* h.source.apply("thread.created", "thread:parent", sourceThread("thread:parent"));
        yield* h.source.apply(
          "run.created",
          "thread:parent",
          sourceRun("run:parent", "thread:parent"),
        );
      }
      for (const id of ["thread:a", "thread:b"]) {
        yield* h.source.apply(
          "thread.created",
          id,
          sourceThread(
            id,
            kind === "subagent-result" && id === "thread:b"
              ? {
                  lineage: {
                    rootThreadId: "thread:parent",
                    parentThreadId: "thread:parent",
                    relationshipToParent: "subagent",
                  },
                  forkedFrom: {
                    type: "node",
                    threadId: "thread:parent",
                    nodeId: "node:run:parent",
                  },
                }
              : {},
          ),
        );
        yield* h.source.apply("run.created", id, sourceRun("run:" + id, id));
      }
      if (kind === "request") {
        yield* h.source.apply("runtime-request.updated", "thread:b", {
          id: "request:b",
          nodeId: "node:run:thread:b",
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: FIXTURE_TIME,
          resolvedAt: null,
        });
      } else if (kind === "subagent-result") {
        assert.deepStrictEqual(
          yield* h.source.store.findWorkCandidates([C.ThreadId.make("thread:b")], {
            now: DateTime.makeUnsafe(FIXTURE_TIME),
          }),
          [{ threadId: C.ThreadId.make("thread:b"), kind: "subagent-results" }],
        );
        yield* Effect.gen(function* () {
          const staging = yield* T3ImportStaging.T3ImportStaging;
          const staged = yield* staging.open({
            sourceHome: h.source.home,
            directory: NodePath.join(h.directory, "unfinished-staged"),
            destinationDb: h.config.dbPath,
            destinationEnvironmentId: C.EnvironmentId.make("environment:synthetic-u4"),
          });
          assert.deepStrictEqual(
            yield* staged.projections.findWorkCandidates([C.ThreadId.make("thread:b")], {
              now: DateTime.makeUnsafe(FIXTURE_TIME),
            }),
            [{ threadId: C.ThreadId.make("thread:b"), kind: "subagent-results" }],
          );
        }).pipe(Effect.provide(T3ImportStaging.layer), Effect.scoped);
      } else {
        const card: Record<string, unknown> = sourceItem("card:b", "thread:b", {
          type: kind === "link" ? "link_request" : "secret_request",
          reason: "Synthetic request",
          ...(kind === "link"
            ? { linkStatus: "pending" }
            : { label: "Synthetic secret", secretStatus: "pending" }),
        });
        delete card.messageId;
        delete card.text;
        delete card.streaming;
        yield* h.source.apply("turn-item.updated", "thread:b", card);
      }
      const memoMap = yield* Layer.makeMemoMap;
      yield* Layer.buildWithMemoMap(
        ProjectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, h.sql))),
        memoMap,
        yield* Effect.scope,
      );
      const underServerCache = Effect.provideService(Layer.CurrentMemoMap, memoMap);
      const { sessionId } = yield* h.importer
        .open({ sourceHome: h.source.home })
        .pipe(underServerCache);
      yield* h.importer.awaitReady(sessionId).pipe(underServerCache);
      const plan = yield* h.importer
        .preview({
          sessionId,
          selection: selection(["thread:a", "thread:b"]),
        })
        .pipe(underServerCache);
      assert.strictEqual(plan.sections.blocked.rows[0]?.category, "pending-work");
      if (kind === "subagent-result")
        assert.include(plan.sections.blocked.rows[0]?.explanation, "subagent-results");
      const { jobId } = yield* h.importer
        .start({ sessionId, planId: plan.planId })
        .pipe(underServerCache);
      yield* h.importer.awaitJob(jobId).pipe(underServerCache);
      const result = yield* h.importer.getJob({ jobId }).pipe(underServerCache);
      assert.sameDeepMembers(
        result.results.map((row) => [row.sourceThreadId, row.outcome]),
        [
          ["thread:a", "imported"],
          ["thread:b", "blocked"],
          ...(kind === "subagent-result" ? [["thread:parent", "blocked"]] : []),
        ],
      );
      assert.strictEqual(
        (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_runtime_requests`).length,
        0,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "rolls back the unit when the real writer-bound recovery query sees transformed queued work",
  () =>
    Effect.gen(function* () {
      let h: Effect.Success<ReturnType<typeof harness>>;
      h = yield* harness().pipe(
        Effect.provideService(T3ImportService.ImportHooks, {
          milestone: (stage) =>
            stage === "before-gate"
              ? h.sql`UPDATE orchestration_v2_projection_runs SET status = 'queued'`.pipe(
                  Effect.asVoid,
                  Effect.orDie,
                )
              : Effect.void,
        }),
      );
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply("run.created", "thread:a", sourceRun("run:a", "thread:a"));
      const imported = yield* importSelection(h, ["thread:a"]);
      assert.strictEqual(imported.result.results[0]?.reason, "would-start-work");
      assert.strictEqual(
        (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`).length,
        0,
      );
      assert.strictEqual((yield* h.sql`SELECT 1 FROM projection_projects`).length, 0);
      assert.strictEqual((yield* h.sql`SELECT 1 FROM orchestration_v2_effect_outbox`).length, 0);
      assert.deepStrictEqual(yield* Effect.promise(() => Publisher.listPublications(h.config)), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "copies fork-owned MCP context through the ancestor item owner and detects deletion of the expected row",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply("run.created", "thread:a", sourceRun("run:a", "thread:a"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("item:a", "thread:a", { runId: "run:a" }),
      );
      yield* h.source.apply(
        "thread.created",
        "thread:b",
        sourceThread("thread:b", {
          lineage: {
            rootThreadId: "thread:a",
            parentThreadId: "thread:a",
            relationshipToParent: "fork",
          },
          forkedFrom: { type: "run", threadId: "thread:a", runId: "run:a" },
        }),
      );
      yield* h.source
        .sql`INSERT INTO mcp_app_model_context VALUES ('thread:b', 'item:a', 'synthetic-server', 'synthetic-tool', 'Preserved MCP application context', ${FIXTURE_TIME})`;
      const first = yield* importSelection(h, ["thread:b"]);
      const b = C.ThreadId.make(
        destinationId("thread:b", ["environment:synthetic-t3", "thread:b", 1]),
      );
      const context = yield* Layer.build(
        McpAppModelContext.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, h.sql))),
      );
      const rows = yield* Context.get(context, McpAppModelContext.McpAppModelContext).forThread(b);
      assert.strictEqual(
        rows[0]?.itemId,
        destinationId("item:a", ["environment:synthetic-t3", "thread:a", 1]),
      );
      assert.strictEqual(rows[0]?.text, "Preserved MCP application context");
      yield* h.sql`DELETE FROM mcp_app_model_context WHERE thread_id = ${b}`;
      const repeated = yield* h.importer.preview({
        sessionId: first.sessionId,
        selection: selection(["thread:b"]),
      });
      assert.ok(
        repeated.sections.threads.rows.some(
          (row) => row.sourceThreadId === "thread:b" && row.category === "copy-incomplete",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([
  "after-unit-staging",
  "assets-published",
  "before-commit",
  "mid-bulk",
  "after-commit",
] as const)("cancels at %s without starting later units or hiding committed results", (boundary) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const h = yield* harness().pipe(
      Effect.provideService(T3ImportService.ImportHooks, {
        milestone: (stage, root) =>
          stage === boundary && root === "thread:a"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      }),
    );
    for (const id of ["thread:a", "thread:b"])
      yield* h.source.apply("thread.created", id, sourceThread(id));
    const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
    yield* h.importer.awaitReady(sessionId);
    const plan = yield* h.importer.preview({
      sessionId,
      selection: selection(["thread:a", "thread:b"]),
    });
    const { jobId } = yield* h.importer.start({ sessionId, planId: plan.planId });
    yield* Deferred.await(entered);
    assert.strictEqual((yield* h.importer.cancel({ jobId })).status, "cancelling");
    const busy = yield* h.importer.open({ sourceHome: h.source.home }).pipe(Effect.result);
    assert.strictEqual(busy._tag, "Failure");
    yield* Deferred.succeed(release, undefined);
    yield* h.importer.awaitJob(jobId);
    const result = yield* h.importer.getJob({ jobId });
    assert.strictEqual(result.status, "cancelled");
    assert.deepStrictEqual(
      result.results.map((row) => row.outcome),
      ["before-commit", "mid-bulk", "after-commit"].includes(boundary)
        ? ["imported", "not-started"]
        : ["not-started", "not-started"],
    );
    assert.strictEqual(
      (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`).length,
      ["before-commit", "mid-bulk", "after-commit"].includes(boundary) ? 1 : 0,
    );
    assert.isFalse((yield* h.sql`PRAGMA database_list`).some((row) => row.name === "t3i_unit"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["conflicting-consumers", "metadata-missing", "pdf-sidecar"] as const)(
  "uses actual message reference bytes with legacy by-ID candidates: %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const sourceId = "legacy-11111111-1111-4111-8111-111111111111";
      const attachment = {
        type: "file",
        id: sourceId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };
      const path = NodePath.join(h.source.userdata, "attachments", sourceId);
      if (kind !== "metadata-missing")
        yield* Effect.promise(() => NodeFSP.writeFile(path + ".pdf", "%PDF-T3"));
      if (kind === "pdf-sidecar")
        yield* Effect.promise(() =>
          NodeFSP.writeFile(path + ".pdf.txt", "Synthetic PDF extraction"),
        );
      else yield* Effect.promise(() => NodeFSP.writeFile(path + ".png", "Unrelated by-ID image"));
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("item:a", "thread:a", { attachments: [attachment] }),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      yield* h.importer.awaitReady(sessionId);
      const preview = yield* h.importer.preview({ sessionId, selection: selection(["thread:a"]) });
      if (kind === "conflicting-consumers") {
        assert.strictEqual(
          preview.sections.blocked.rows[0]?.category,
          "asset-reference-unsupported",
        );
        assert.strictEqual(preview.totals.importing, 0);
        return;
      }
      const { jobId } = yield* h.importer.start({ sessionId, planId: preview.planId });
      yield* h.importer.awaitJob(jobId);
      const result = yield* h.importer.getJob({ jobId });
      assert.strictEqual(result.results[0]?.outcome, "imported");
      const projection = yield* h.store.getThreadProjection(
        result.results[0]!.destinationThreadId!,
      );
      const item = projection.turnItems.find((row) => row.type === "assistant_message");
      assert.ok(item?.type === "assistant_message");
      const copied = item.attachments![0]!;
      if (kind === "metadata-missing") {
        assert.strictEqual(parseAttachmentFileExtension(copied.id), "missing");
        assert.strictEqual(
          resolveAttachmentPathById({
            attachmentsDir: h.config.attachmentsDir,
            attachmentId: copied.id,
          }),
          null,
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(h.config.attachmentsDir)),
          [],
        );
      } else {
        const final = resolveAttachmentPathById({
          attachmentsDir: h.config.attachmentsDir,
          attachmentId: copied.id,
        });
        assert.strictEqual(
          yield* Effect.promise(() => NodeFSP.readFile(final!, "utf8")),
          "%PDF-T3",
        );
        assert.strictEqual(
          yield* Effect.promise(() => NodeFSP.readFile(final! + ".txt", "utf8")),
          "Synthetic PDF extraction",
        );
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["html-json", "html-content", "mcp", "recording", "duplicate"] as const)(
  "re-owns recognized tool assets through the actual importer: %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const extension = kind === "recording" ? "mp4" : "html";
      const sourceId = "legacy-11111111-1111-4111-8111-111111111111-" + extension;
      const data =
        kind === "recording"
          ? { id: sourceId, path: "private display path" }
          : kind === "mcp"
            ? {
                t3McpApp: {
                  attachmentId: sourceId,
                  server: "example",
                  tool: "view",
                  resourceUri: "ui://example/view",
                },
              }
            : {
                htmlRender: { attachmentId: sourceId, title: "Synthetic view", height: 320 },
                ...(kind === "duplicate" ? { note: sourceId } : {}),
              };
      const output =
        kind === "html-json" || kind === "duplicate"
          ? JSON.stringify(data)
          : kind === "html-content"
            ? { content: [{ type: "text", text: JSON.stringify(data) }] }
            : data;
      const toolName =
        kind === "recording"
          ? "preview_recording_stop"
          : kind === "mcp"
            ? "example.view"
            : "html_render";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(h.source.userdata, "attachments", sourceId + "." + extension),
          "Synthetic asset bytes",
        ),
      );
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:a",
        sourceItem("tool:a", "thread:a", {
          type: "dynamic_tool",
          toolName,
          input: { retained: "literal source identifier" },
          output,
        }),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      yield* h.importer.awaitReady(sessionId);
      const preview = yield* h.importer.preview({ sessionId, selection: selection(["thread:a"]) });
      if (kind === "duplicate") {
        assert.strictEqual(
          preview.sections.blocked.rows[0]?.category,
          "asset-reference-unsupported",
        );
        return;
      }
      const { jobId } = yield* h.importer.start({ sessionId, planId: preview.planId });
      yield* h.importer.awaitJob(jobId);
      const result = yield* h.importer.getJob({ jobId });
      assert.strictEqual(result.results[0]?.outcome, "imported");
      const projection = yield* h.store.getThreadProjection(
        result.results[0]!.destinationThreadId!,
      );
      const item = projection.turnItems.find((item) => item.type === "dynamic_tool");
      assert.ok(item?.type === "dynamic_tool");
      const copiedId = toolAssetId(item)!;
      assert.notStrictEqual(copiedId, sourceId);
      assert.strictEqual(parseAttachmentFileExtension(copiedId), extension);
      assert.deepStrictEqual(item.input, { retained: "literal source identifier" });
      assert.strictEqual(
        JSON.stringify(item.output).replaceAll(copiedId, sourceId),
        JSON.stringify(output),
      );
      const final = resolveAttachmentPathById({
        attachmentsDir: h.config.attachmentsDir,
        attachmentId: copiedId,
      });
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(final!, "utf8")),
        "Synthetic asset bytes",
      );
      assert.ok(
        (yield* h.store.getThreadAttachmentIds(result.results[0]!.destinationThreadId!)).includes(
          copiedId,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["latest-rolled-back", "all-rolled-back", "empty-side-chat"] as const)(
  "keeps the import notice in the first bounded visible window: %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      if (kind === "empty-side-chat")
        yield* h.source.apply(
          "thread.created",
          "thread:side",
          sourceThread("thread:side", {
            lineage: {
              rootThreadId: "thread:a",
              parentThreadId: "thread:a",
              relationshipToParent: "fork",
              sideChat: true,
            },
          }),
        );
      else {
        if (kind === "latest-rolled-back")
          yield* h.source.apply("run.created", "thread:a", sourceRun("run:visible", "thread:a"));
        yield* h.source.apply(
          "run.created",
          "thread:a",
          sourceRun("run:rolled", "thread:a", { ordinal: 2, status: "rolled_back" }),
        );
        yield* h.source.sql.withTransaction(
          Effect.gen(function* () {
            for (let index = 0; index < 520; index++)
              yield* h.source.apply(
                "turn-item.updated",
                "thread:a",
                sourceItem("item:" + index, "thread:a", {
                  ordinal: index + 1,
                  runId: "run:rolled",
                }),
              );
          }),
        );
      }
      const imported = yield* importSelection(h, ["thread:a"]);
      const id = imported.result.results.find(
        (row) => row.sourceThreadId === "thread:a",
      )!.destinationThreadId!;
      const window = yield* h.store.getThreadSnapshotWindow(id, { rowLimit: 10 });
      assert.ok(
        window.projection.visibleTurnItems.some((row) => row.item.type === "system_notice"),
      );
      if (kind === "empty-side-chat") {
        assert.ok(
          imported.result.results.some(
            (row) =>
              row.sourceThreadId === "thread:side" &&
              row.outcome === "skipped" &&
              row.reason === "empty-side-chat",
          ),
        );
        assert.strictEqual(
          (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`).length,
          1,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["whole-project", "unit-limit", "attached-closure"] as const)(
  "refuses the complete oversized selection with exact scalar counts before materialization: %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const count = kind === "whole-project" ? 302 : kind === "unit-limit" ? 101 : 301;
      yield* h.source.sql.withTransaction(
        Effect.gen(function* () {
          for (let index = 0; index < count; index++)
            yield* h.source.apply(
              "thread.created",
              "thread:" + index,
              sourceThread(
                "thread:" + index,
                kind === "attached-closure" && index > 0
                  ? {
                      lineage: {
                        rootThreadId: "thread:0",
                        parentThreadId: "thread:0",
                        relationshipToParent: "subagent",
                      },
                    }
                  : {},
              ),
            );
        }),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      yield* h.importer.awaitReady(sessionId);
      const selected =
        kind === "whole-project"
          ? { ...selection([]), projectIds: [C.ProjectId.make("project:source")] }
          : selection(
              kind === "attached-closure"
                ? ["thread:0"]
                : Array.from({ length: count }, (_, index) => "thread:" + index),
            );
      const result = yield* h.importer
        .preview({ sessionId, selection: selected })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "too-large");
        assert.strictEqual(result.failure.actual, count);
        assert.strictEqual(result.failure.maximum, kind === "unit-limit" ? 100 : 300);
      }
      assert.strictEqual(
        (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`).length,
        0,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([false, true])(
  "discloses and applies the managed runtime ceiling before inserting imported threads (changed=%s)",
  (changedCeiling) =>
    Effect.gen(function* () {
      const h = yield* harness(changedCeiling ? "full-access" : "approval-required");
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      let imported: Effect.Success<ReturnType<typeof importSelection>>;
      if (changedCeiling) {
        const opened = yield* h.importer.open({ sourceHome: h.source.home });
        yield* h.importer.awaitReady(opened.sessionId);
        const old = yield* h.importer.preview({
          sessionId: opened.sessionId,
          selection: selection(["thread:a"]),
        });
        Object.defineProperty(h.settings.managedPolicy!.limits!, "maxRuntimeMode", {
          value: "approval-required",
        });
        assert.equal(
          (yield* h.importer
            .start({ sessionId: opened.sessionId, planId: old.planId })
            .pipe(Effect.flip)).reason,
          "plan-changed",
        );
        const preview = yield* h.importer.preview({
          sessionId: opened.sessionId,
          selection: selection(["thread:a"]),
        });
        const started = yield* h.importer.start({
          sessionId: opened.sessionId,
          planId: preview.planId,
        });
        yield* h.importer.awaitJob(started.jobId);
        imported = {
          sessionId: opened.sessionId,
          preview,
          result: yield* h.importer.getJob(started),
        };
      } else imported = yield* importSelection(h, ["thread:a"]);
      assert.ok(
        imported.preview.sections.warnings.rows.some(
          (row) =>
            row.category === "runtime-mode-lowered" &&
            row.count === 1 &&
            row.explanation.includes("approval-required"),
        ),
      );
      const thread = yield* h.store.getThread(imported.result.results[0]!.destinationThreadId!);
      assert.strictEqual(thread.runtimeMode, "approval-required");
      assert.strictEqual(
        (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_provider_sessions`).length,
        0,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([
  "ancestor-state",
  "project-root",
  "child-deleted",
  "child-generation",
  "duplicate-owned",
  "foreign-owned",
  "stored-count",
  "notice-item",
  "notice-position",
  "context-row",
  "runtime-ceiling",
] as const)("revalidates reused structural state inside the destination transaction: %s", (kind) =>
  Effect.gen(function* () {
    let h: Effect.Success<ReturnType<typeof harness>>,
      race = false;
    h = yield* harness("full-access").pipe(
      Effect.provideService(T3ImportService.ImportHooks, {
        milestone: (stage, root) =>
          Effect.gen(function* () {
            if (!race || stage !== "before-commit" || root !== "thread:b") return;
            const a = destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 1]);
            const child = destinationId("thread:child", [
              "environment:synthetic-t3",
              "thread:a",
              1,
            ]);
            const transfer = destinationId("transfer:owned", [
              "environment:synthetic-t3",
              "thread:a",
              1,
            ]);
            if (kind === "runtime-ceiling")
              Object.defineProperty(h.settings.managedPolicy!.limits!, "maxRuntimeMode", {
                value: "approval-required",
              });
            else if (kind === "ancestor-state")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${FIXTURE_TIME}`;
            else if (kind === "project-root")
              yield* h.sql`UPDATE projection_projects SET workspace_root = '/synthetic/replaced'`;
            else if (kind === "child-deleted")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${FIXTURE_TIME} WHERE thread_id = ${child}`;
            else if (kind === "child-generation")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,'$.importedFrom.generation',99) WHERE thread_id = ${child}`;
            else if (kind === "duplicate-owned")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,'$.importedFrom.ownedTransferIds',json_array(${transfer},${transfer})) WHERE thread_id = ${a}`;
            else if (kind === "foreign-owned")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,'$.importedFrom.ownedTransferIds',json_array('transfer:foreign')) WHERE thread_id = ${a}`;
            else if (kind === "stored-count")
              yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,'$.importedFrom.importedRowCounts.orchestration_v2_projection_turn_items',999) WHERE thread_id = ${a}`;
            else if (kind === "notice-item")
              yield* h.sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${destinationId("notice:thread:a", ["environment:synthetic-t3", "thread:a", 1])}`;
            else if (kind === "notice-position")
              yield* h.sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${a} AND turn_item_id = ${destinationId("notice:thread:a", ["environment:synthetic-t3", "thread:a", 1])}`;
            else
              yield* h.sql`DELETE FROM mcp_app_model_context WHERE thread_id = ${a} AND item_id = ${destinationId("item:a", ["environment:synthetic-t3", "thread:a", 1])}`;
          }).pipe(Effect.orDie),
      }),
    );
    yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
    yield* h.source.apply("run.created", "thread:a", sourceRun("run:a", "thread:a"));
    yield* h.source.apply(
      "thread.created",
      "thread:b",
      sourceThread("thread:b", {
        lineage: {
          rootThreadId: "thread:a",
          parentThreadId: "thread:a",
          relationshipToParent: "fork",
        },
        forkedFrom: { type: "run", threadId: "thread:a", runId: "run:a" },
      }),
    );
    yield* h.source.apply(
      "thread.created",
      "thread:child",
      sourceThread("thread:child", {
        lineage: {
          rootThreadId: "thread:a",
          parentThreadId: "thread:a",
          relationshipToParent: "subagent",
        },
      }),
    );
    yield* h.source.apply(
      "turn-item.updated",
      "thread:a",
      sourceItem("item:a", "thread:a", { runId: "run:a" }),
    );
    yield* h.source
      .sql`INSERT INTO mcp_app_model_context VALUES ('thread:a','item:a','server','tool','Full ancestor context',${FIXTURE_TIME})`;
    yield* h.source.apply("context-transfer.created", "thread:child", {
      id: "transfer:owned",
      type: "subagent_spawn",
      sourceThreadId: "thread:a",
      targetThreadId: "thread:child",
      sourcePoint: { threadId: "thread:a", runId: "run:a" },
      basePoint: null,
      sourceProviderInstanceId: "codex",
      targetProviderInstanceId: "codex",
      targetRunId: null,
      status: "consumed",
      resolution: null,
      createdBy: "agent",
      error: null,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
      consumedAt: FIXTURE_TIME,
    });
    const first = yield* importSelection(h, ["thread:a"]);
    const preview = yield* h.importer.preview({
      sessionId: first.sessionId,
      selection: selection(["thread:b"]),
    });
    race = true;
    const { jobId } = yield* h.importer.start({
      sessionId: first.sessionId,
      planId: preview.planId,
    });
    yield* h.importer.awaitJob(jobId);
    const result = yield* h.importer.getJob({ jobId });
    assert.ok(
      result.results.some(
        (row) =>
          row.sourceThreadId === "thread:b" &&
          row.outcome === "failed" &&
          row.reason === (kind === "runtime-ceiling" ? "policy-refused" : "dependency-changed"),
      ),
    );
    const b = destinationId("thread:b", ["environment:synthetic-t3", "thread:b", 1]);
    assert.strictEqual(
      (yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${b}`)
        .length,
      0,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["intact", "deleted", "new-generation"] as const)(
  "re-resolves a run's source plan reference to an unselected copy: %s",
  (mutation) =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const id of ["thread:a", "thread:b"])
        yield* h.source.apply("thread.created", id, sourceThread(id));
      yield* h.source.apply("plan.updated", "thread:a", {
        id: "plan:a",
        threadId: "thread:a",
        runId: null,
        nodeId: "node:a",
        status: "completed",
        kind: "proposed_plan",
        markdown: "Synthetic source plan",
      });
      yield* h.source.apply(
        "run.created",
        "thread:b",
        sourceRun("run:b", "thread:b", {
          sourcePlanRef: { threadId: "thread:a", planId: "plan:a" },
        }),
      );
      const first = yield* importSelection(h, ["thread:a"]);
      const preview = yield* h.importer.preview({
        sessionId: first.sessionId,
        selection: selection(["thread:b"]),
      });
      assert.deepStrictEqual(preview.sections.dependencies.rows, []);
      if (mutation === "deleted")
        yield* h.sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id=${destinationId("plan:a", ["environment:synthetic-t3", "thread:a", 1])}`;
      if (mutation === "new-generation") {
        const original = yield* h.store.getThreadProjection(
          C.ThreadId.make(destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 1])),
        );
        const threadId = C.ThreadId.make(
          destinationId("thread:a", ["environment:synthetic-t3", "thread:a", 2]),
        );
        yield* h.store.apply({
          id: C.EventId.make("fixture:new-generation:thread"),
          type: "thread.created",
          threadId,
          occurredAt: DateTime.makeUnsafe(FIXTURE_TIME),
          payload: {
            ...original.thread,
            id: threadId,
            importedFrom: { ...original.thread.importedFrom!, generation: 2 },
          },
        });
        yield* h.store.apply({
          id: C.EventId.make("fixture:new-generation:plan"),
          type: "plan.updated",
          threadId,
          occurredAt: DateTime.makeUnsafe(FIXTURE_TIME),
          payload: {
            ...original.plans[0]!,
            id: C.PlanId.make(destinationId("plan:a", ["environment:synthetic-t3", "thread:a", 2])),
            threadId,
          },
        });
      }
      const started = yield* h.importer
        .start({ sessionId: first.sessionId, planId: preview.planId })
        .pipe(Effect.result);
      let jobId: C.T3ImportJobId;
      if (started._tag === "Failure") {
        assert.equal(started.failure.reason, "plan-changed");
        const refreshed = yield* h.importer.preview({
          sessionId: first.sessionId,
          selection: selection(["thread:b"]),
        });
        jobId = (yield* h.importer.start({ sessionId: first.sessionId, planId: refreshed.planId }))
          .jobId;
      } else jobId = started.success.jobId;
      yield* h.importer.awaitJob(jobId);
      const result = yield* h.importer.getJob({ jobId });
      assert.strictEqual(result.results[0]?.outcome, "imported");
      const projection = yield* h.store.getThreadProjection(
        result.results[0]!.destinationThreadId!,
      );
      const generation = mutation === "new-generation" ? 2 : 1;
      assert.deepStrictEqual(
        projection.runs[0]?.sourcePlanRef,
        mutation === "deleted"
          ? undefined
          : {
              threadId: destinationId("thread:a", [
                "environment:synthetic-t3",
                "thread:a",
                generation,
              ]),
              planId: destinationId("plan:a", ["environment:synthetic-t3", "thread:a", generation]),
            },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("pages all attached-member outcomes without losing completed result rows", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.source.sql.withTransaction(
      Effect.gen(function* () {
        for (let index = 0; index < 150; index++)
          yield* h.source.apply(
            "thread.created",
            "thread:" + index,
            sourceThread(
              "thread:" + index,
              index === 0
                ? {}
                : {
                    lineage: {
                      rootThreadId: "thread:0",
                      parentThreadId: "thread:0",
                      relationshipToParent: "subagent",
                    },
                  },
            ),
          );
      }),
    );
    const imported = yield* importSelection(h, ["thread:0"]);
    assert.strictEqual(imported.result.progress.completed, 150);
    assert.strictEqual(imported.result.results.length, 100);
    assert.ok(imported.result.nextCursor);
    const next = yield* h.importer.getJob({
      jobId: imported.result.jobId,
      cursor: imported.result.nextCursor!,
    });
    assert.strictEqual(next.results.length, 50);
    assert.strictEqual(next.nextCursor, null);
    assert.strictEqual(
      new Set([...imported.result.results, ...next.results].map((row) => row.sourceThreadId)).size,
      150,
    );
    assert.ok(
      [...imported.result.results, ...next.results].every((row) => row.outcome === "imported"),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("pages source inventory without expanding or partially selecting a large project", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.source.sql.withTransaction(
      Effect.gen(function* () {
        for (let index = 0; index < 101; index++)
          yield* h.source
            .sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${"project:" + index}, 'Synthetic project', ${h.directory}, '[]', ${FIXTURE_TIME}, ${FIXTURE_TIME})`;
        for (let index = 0; index < 201; index++)
          yield* h.source.apply(
            "thread.created",
            "thread:" + String(index).padStart(3, "0"),
            sourceThread("thread:" + String(index).padStart(3, "0")),
          );
      }),
    );
    const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
    yield* h.importer.awaitReady(sessionId);
    const first = yield* h.importer.getSession({ sessionId });
    assert.strictEqual(first.projects.length, 100);
    assert.ok(first.nextProjectCursor);
    const more = yield* h.importer.getSession({
      sessionId,
      projectCursor: first.nextProjectCursor!,
    });
    assert.strictEqual(more.projects.length, 2);
    assert.strictEqual(more.nextProjectCursor, null);
    const threads = yield* h.importer.listThreads({
      sessionId,
      sourceProjectId: C.ProjectId.make("project:source"),
    });
    assert.strictEqual(threads.threads.length, 100);
    assert.ok(threads.nextCursor);
    const middle = yield* h.importer.listThreads({
      sessionId,
      sourceProjectId: C.ProjectId.make("project:source"),
      cursor: threads.nextCursor!,
    });
    assert.strictEqual(middle.threads.length, 100);
    assert.ok(middle.nextCursor);
    const last = yield* h.importer.listThreads({
      sessionId,
      sourceProjectId: C.ProjectId.make("project:source"),
      cursor: middle.nextCursor!,
    });
    assert.strictEqual(last.threads.length, 1);
    assert.strictEqual(last.nextCursor, null);
    assert.strictEqual((yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`).length, 0);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "creates a new generation when an originally live attached member was later deleted",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.source.apply("thread.created", "thread:a", sourceThread("thread:a"));
      yield* h.source.apply(
        "thread.created",
        "thread:child",
        sourceThread("thread:child", {
          lineage: {
            rootThreadId: "thread:a",
            parentThreadId: "thread:a",
            relationshipToParent: "subagent",
          },
        }),
      );
      const first = yield* importSelection(h, ["thread:a"]);
      const childId = C.ThreadId.make(
        destinationId("thread:child", ["environment:synthetic-t3", "thread:a", 1]),
      );
      const child = yield* h.store.getThread(childId);
      yield* h.store.apply({
        id: C.EventId.make("fixture:delete-member"),
        type: "thread.deleted",
        threadId: childId,
        occurredAt: DateTime.makeUnsafe(FIXTURE_TIME),
        payload: { ...child, deletedAt: DateTime.makeUnsafe(FIXTURE_TIME) },
      });
      const plan = yield* h.importer.preview({
        sessionId: first.sessionId,
        selection: selection(["thread:a"]),
      });
      assert.ok(
        plan.sections.threads.rows.every(
          (row) => row.category === "imported-then-deleted" && row.generation === 2,
        ),
      );
      const { jobId } = yield* h.importer.start({
        sessionId: first.sessionId,
        planId: plan.planId,
      });
      yield* h.importer.awaitJob(jobId);
      const result = yield* h.importer.getJob({ jobId });
      assert.ok(result.results.every((row) => row.outcome === "imported"));
      assert.ok((yield* h.store.getThread(childId)).deletedAt);
      const next = yield* h.store.getThread(
        C.ThreadId.make(destinationId("thread:child", ["environment:synthetic-t3", "thread:a", 2])),
      );
      assert.strictEqual(next.deletedAt, null);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("matches the frozen b31 small stored-history oracle", () =>
  Effect.gen(function* () {
    const h = yield* harness(undefined, 81);
    const { root, fork } = yield* goldenSource(h);
    const imported = yield* importSelection(h, [fork, root]);
    assert.ok(imported.result.results.every((result) => result.outcome === "imported"));
    const dump: Record<string, unknown> = {};
    const ledger: unknown[] = [];
    const referenceKeys = new Map<string, UnitKey>();
    referenceKeys.set("project:source", [
      "environment:synthetic-t3",
      "project:project:source:" + digest("/tmp"),
      1,
    ]);
    for (const table of RECORD_TABLES) {
      const originals = yield* h.source.sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "${PROJECTION_PREFIX + table}"`,
      );
      for (const row of originals) {
        const original = JSON.parse(String(row.payload_json));
        const owner = table === "context_transfers" ? fork : row.thread_id;
        referenceKeys.set(original.id, [
          "environment:synthetic-t3",
          owner === fork ? fork : root,
          1,
        ]);
      }
    }
    for (const table of [
      ...RECORD_TABLES.map((t) => PROJECTION_PREFIX + t),
      "orchestration_v2_turn_item_positions",
      "mcp_app_model_context",
    ]) {
      const rows = yield* h.sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "${table}" ORDER BY rowid`,
      );
      if (table === PROJECTION_PREFIX + "turn_items") {
        assert.deepStrictEqual(
          rows.map((row) => row.inline_work_output),
          [0, 0, 0, 0, 0, 0, 0],
        );
        dump[table] = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([column]) => column !== "inline_work_output"),
          ),
        );
      } else dump[table] = rows;
      if (table.startsWith(PROJECTION_PREFIX)) {
        const kind = table.slice(PROJECTION_PREFIX.length) as (typeof RECORD_TABLES)[number];
        const originals = yield* h.source.sql.unsafe<{ payload_json: string; thread_id: string }>(
          `SELECT * FROM "${table}" ORDER BY rowid`,
        );
        for (const row of originals) {
          const original = JSON.parse(row.payload_json);
          const owner = kind === "context_transfers" ? fork : row.thread_id;
          const unit = owner === fork ? fork : root;
          const key = ["environment:synthetic-t3", unit, 1] as const;
          const target = rows.find(
            (candidate) =>
              JSON.parse(String(candidate.payload_json)).id === destinationId(original.id, key),
          );
          assert.ok(target);
          ledger.push(
            verifyImportedRecord(
              kind,
              original,
              JSON.parse(String(target.payload_json)),
              key,
              referenceKeys,
            ),
          );
        }
      }
    }
    const countTables = yield* h.sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%count%' ORDER BY name`;
    for (const table of countTables)
      dump[table.name] = yield* h.sql.unsafe(`SELECT * FROM "${table.name}" ORDER BY thread_id`);
    dump.events =
      yield* h.sql`SELECT event_id, event_type, stream_id, occurred_at, payload_json FROM orchestration_events WHERE event_type = 'thread.created' ORDER BY sequence`;
    dump.fts =
      yield* h.sql`SELECT messages.message_id FROM orchestration_v2_projection_messages messages JOIN orchestration_v2_message_search search ON search.rowid = messages.rowid ORDER BY messages.message_id`;
    const handoff: unknown[] = [];
    for (const result of imported.result.results) {
      const items = yield* h.store.getTurnStartHistory(result.destinationThreadId!);
      handoff.push([
        result.sourceThreadId,
        selectHistory({
          messages: items.map(historicalMessage).filter((m) => m !== null),
          coverage: "Full imported conversation",
          budget: 16000,
        }),
      ]);
    }
    const actual = { preview: { ...imported.preview, planId: "<plan-id>" }, dump, ledger, handoff };
    const golden = new URL("./testkit/b31-import-golden.json", import.meta.url);
    const goldenJson = yield* Effect.promise(() => NodeFSP.readFile(golden, "utf8"));
    assert.strictEqual(
      NodeCrypto.createHash("sha256").update(goldenJson).digest("hex"),
      "b92620455a9ad98a52b92a9544537061e84bbab19c3e512cbd52bf624f7bb057",
    );
    assert.deepStrictEqual(actual, JSON.parse(goldenJson));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "refuses a second live importer before touching the owner's staged files or journal",
  () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness().pipe(
        Effect.provideService(T3ImportService.ImportHooks, {
          milestone: (stage) =>
            stage === "assets-published"
              ? Deferred.succeed(published, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        }),
      );
      yield* h.source.apply("thread.created", "thread:owner", sourceThread("thread:owner"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:owner",
        sourceItem("item:owner", "thread:owner"),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      yield* h.importer.awaitReady(sessionId);
      const preview = yield* h.importer.preview({
        sessionId,
        selection: selection(["thread:owner"]),
      });
      const { jobId } = yield* h.importer.start({ sessionId, planId: preview.planId });
      yield* Deferred.await(published);
      const before = yield* Effect.promise(() => Publisher.listPublications(h.config));
      const directory = NodePath.join(
        h.config.stateDir,
        "imports",
        "t3",
        "sessions",
        sessionId,
        "units",
      );
      const attempts = yield* Effect.promise(() => NodeFSP.readdir(directory));
      const filename = NodePath.join(directory, attempts[0]!, "stage.sqlite");
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(filename));
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const other = yield* h.newImporter(scope);
      const refused = yield* other.open({ sourceHome: h.source.home }).pipe(Effect.flip);
      assert.equal(refused.reason, "busy");
      assert.equal(refused.stage, "import-owner");
      assert.deepStrictEqual(
        yield* Effect.promise(() => Publisher.listPublications(h.config)),
        before,
      );
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(filename)), bytes);
      yield* h.sql`CREATE TABLE ordinary_import_neighbor(id INTEGER)`;
      yield* h.sql`INSERT INTO ordinary_import_neighbor VALUES (1)`;
      yield* Deferred.succeed(release, undefined);
      yield* h.importer.awaitJob(jobId);
      assert.equal((yield* h.importer.getJob({ jobId })).results[0]?.outcome, "imported");
      yield* Scope.close(h.importerScope, Exit.void);
      const next = yield* other.open({ sourceHome: h.source.home });
      yield* other.awaitReady(next.sessionId);
      assert.deepStrictEqual(yield* h.sql`SELECT id FROM ordinary_import_neighbor`.values, [[1]]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["retry", "database-close"] as const)(
  "retains the attachment, descriptor, path and admission until safe cleanup: %s",
  (finish) =>
    Effect.gen(function* () {
      let refuse = true;
      let filename = "";
      let inode: { dev: number; ino: number } | undefined;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness().pipe(
            Effect.provideService(T3ImportService.ImportHooks, {
              milestone: (stage) =>
                stage === "before-detach" && refuse
                  ? Effect.fail(
                      new C.T3ImportError({ reason: "staging-failed", stage: "injected-detach" }),
                    )
                  : Effect.void,
            }),
          );
          yield* h.source.apply("thread.created", "thread:pinned", sourceThread("thread:pinned"));
          yield* h.source.apply(
            "turn-item.updated",
            "thread:pinned",
            sourceItem("item:pinned", "thread:pinned"),
          );
          const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
          yield* h.importer.awaitReady(sessionId);
          const preview = yield* h.importer.preview({
            sessionId,
            selection: selection(["thread:pinned"]),
          });
          const { jobId } = yield* h.importer.start({ sessionId, planId: preview.planId });
          yield* h.importer.awaitJob(jobId);
          const units = NodePath.join(
            h.config.stateDir,
            "imports",
            "t3",
            "sessions",
            sessionId,
            "units",
          );
          const attempts = yield* Effect.promise(() => NodeFSP.readdir(units));
          filename = NodePath.join(units, attempts[0]!, "stage.sqlite");
          inode = yield* Effect.promise(() => NodeFSP.stat(filename));
          assert.isTrue(NodeSqliteClient.importAttachmentLifetime(h.sql)!.retained());
          assert.equal((yield* h.importer.getJob({ jobId })).results[0]?.outcome, "imported");
          yield* TestClock.adjust("31 minutes");
          assert.deepStrictEqual(
            yield* h.sql`SELECT name FROM pragma_database_list WHERE name = 't3i_unit'`.values,
            [["t3i_unit"]],
          );
          const root =
            yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${destinationId("thread:pinned", ["environment:synthetic-t3", "thread:pinned", 1])}`;
          assert.equal(root.length, 1);
          yield* Scope.close(h.importerScope, Exit.void);
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const replacement = yield* h.newImporter(scope);
          assert.equal(
            (yield* replacement.open({ sourceHome: h.source.home }).pipe(Effect.flip)).stage,
            "cleanup-blocked",
          );
          assert.equal((yield* Effect.promise(() => NodeFSP.stat(filename))).ino, inode.ino);
          if (finish === "retry") {
            refuse = false;
            const next = yield* replacement.open({ sourceHome: h.source.home });
            yield* replacement.awaitReady(next.sessionId);
            assert.isFalse(NodeSqliteClient.importAttachmentLifetime(h.sql)!.retained());
            assert.deepStrictEqual(
              yield* h.sql`SELECT name FROM pragma_database_list WHERE name = 't3i_unit'`,
              [],
            );
          }
        }),
      );
      assert.ok(inode);
      const descriptors = yield* Effect.promise(async () => {
        const result: number[] = [];
        for (const fd of await NodeFSP.readdir("/proc/self/fd")) {
          try {
            const stat = await NodeFSP.stat(`/proc/self/fd/${fd}`);
            if (stat.dev === inode!.dev && stat.ino === inode!.ino) result.push(Number(fd));
          } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
              throw cause;
          }
        }
        return result;
      });
      assert.deepStrictEqual(descriptors, []);
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(filename).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live(
  "refuses a cross-process live owner, then recovers its witnessed files after captured-PID crash",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Scope.close(h.importerScope, Exit.void);
      const ownedProcess = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const child = NodeChildProcess.spawn(
            globalThis.process.execPath,
            [
              new URL("./testkit/ImportOwnerProcess.ts", import.meta.url).pathname,
              h.config.stateDir,
              h.config.attachmentsDir,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          let output = "",
            errors = "";
          child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
          });
          const ready = new Promise<{ stagePath: string; finalPath: string }>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", () =>
              reject(new Error("Synthetic owner exited before ready: " + errors)),
            );
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString();
              if (output.includes("\n")) resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
            });
          });
          return { child, closed, ready };
        }),
        (owned) =>
          Effect.promise(async () => {
            if (owned.child.exitCode === null && owned.child.signalCode === null)
              owned.child.kill("SIGKILL");
            await owned.closed;
          }),
      );
      const ready = yield* Effect.promise(() => ownedProcess.ready);
      const stage = yield* Effect.promise(() => NodeFSP.readFile(ready.stagePath));
      const asset = yield* Effect.promise(() => NodeFSP.readFile(ready.finalPath));
      const journals = yield* Effect.promise(() => Publisher.listPublications(h.config));
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const other = yield* h.newImporter(scope);
      assert.equal(
        (yield* other.open({ sourceHome: h.source.home }).pipe(Effect.flip)).stage,
        "import-owner",
      );
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(ready.stagePath)), stage);
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(ready.finalPath)), asset);
      assert.deepStrictEqual(
        yield* Effect.promise(() => Publisher.listPublications(h.config)),
        journals,
      );
      ownedProcess.child.kill("SIGKILL");
      yield* Effect.promise(() => ownedProcess.closed);
      const opened = yield* other.open({ sourceHome: h.source.home });
      yield* other.awaitReady(opened.sessionId);
      assert.deepStrictEqual(yield* Effect.promise(() => Publisher.listPublications(h.config)), []);
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(ready.finalPath).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(ready.stagePath).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(
  (
    [
      ...RECORD_TABLES,
      "positions",
      "contexts",
      "notice",
      "notice-position",
      "position-ordinal",
    ] as const
  ).flatMap((kind) =>
    [false, true]
      .filter(
        (differentOwner) =>
          !differentOwner ||
          (kind !== "threads" &&
            kind !== "positions" &&
            kind !== "contexts" &&
            kind !== "notice-position" &&
            kind !== "position-ordinal"),
      )
      .map((differentOwner) => ({ kind, differentOwner })),
  ),
)(
  "preserves a foreign conflict inserted by an independent SQLite connection: $kind, different owner=$differentOwner",
  ({ kind, differentOwner }) =>
    Effect.gen(function* () {
      let insert = Effect.void as Effect.Effect<void, never>;
      const h = yield* harness().pipe(
        Effect.provideService(T3ImportService.ImportHooks, {
          milestone: (stage) => (stage === "before-commit" ? insert : Effect.void),
        }),
      );
      const { root, fork } = yield* goldenSource(h);
      const golden = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(new URL("./testkit/b31-import-golden.json", import.meta.url), "utf8"),
        ),
      ) as { dump: Record<string, Array<Record<string, string | number | null>>> };
      let handoff: Record<string, string | number | null> | undefined;
      if (kind === "context_handoffs") {
        yield* h.source.apply("context-handoff.updated", root, {
          id: "handoff:golden:conflict",
          threadId: root,
          targetRunId: "run:root",
          fromProviderThreadIds: [],
          toProviderThreadId: "provider-thread:source",
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Complete stored handoff",
          createdByProviderInstanceId: null,
          createdAt: FIXTURE_TIME,
          updatedAt: FIXTURE_TIME,
        });
        const rows = yield* h.source.sql<
          Record<string, string | number | null>
        >`SELECT * FROM orchestration_v2_projection_context_handoffs`;
        handoff = {
          ...rows[0]!,
          context_handoff_id: destinationId("handoff:golden:conflict", [
            "environment:synthetic-t3",
            root,
            1,
          ]),
        };
      }
      const table =
        kind === "positions" || kind === "notice-position" || kind === "position-ordinal"
          ? "orchestration_v2_turn_item_positions"
          : kind === "contexts"
            ? "mcp_app_model_context"
            : PROJECTION_PREFIX + (kind === "notice" ? "turn_items" : kind);
      const noticeId = destinationId("notice:" + root, ["environment:synthetic-t3", root, 1]);
      const row = {
        ...(handoff ??
          golden.dump[table]!.find((row) =>
            kind === "notice" || kind === "notice-position" ? row.turn_item_id === noticeId : true,
          )!),
      };
      if (differentOwner) {
        row[kind === "context_transfers" ? "source_thread_id" : "thread_id"] =
          "thread:foreign-owner";
        if (typeof row.payload_json === "string")
          row.payload_json = JSON.stringify({
            ...JSON.parse(row.payload_json),
            threadId: "thread:foreign-owner",
          });
      }
      if (kind === "position-ordinal") row.turn_item_id = "item:foreign-position";
      if (kind === "threads")
        row.payload_json = JSON.stringify({
          ...JSON.parse(String(row.payload_json)),
          importedFrom: undefined,
          title: "Foreign thread",
        });
      const columns = Object.keys(row);
      const outside = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(h.config.dbPath)),
        (db) => Effect.sync(() => db.close()),
      );
      let written = false;
      insert = Effect.sync(() => {
        if (written) return;
        written = true;
        outside
          .prepare(
            `INSERT INTO "${table}" (${columns.map((column) => '"' + column + '"').join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...columns.map((column) => row[column]!));
      });
      const imported = yield* importSelection(h, [root, fork]);
      assert.ok(imported.result.results.some((result) => result.outcome !== "imported"));
      const rows = outside.prepare(`SELECT * FROM "${table}"`).all();
      assert.ok(
        rows.some((candidate) => columns.every((column) => candidate[column] === row[column])),
      );
      assert.isTrue(written);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["replacement", "symlink", "directory", "same-inode", "retained-writer"] as const)(
  "binds the sealed private database across the worker-open boundary: %s",
  (kind) =>
    Effect.gen(function* () {
      let units = "",
        stagePath = "",
        changed = false;
      let writer: NodeFSP.FileHandle | undefined;
      yield* Effect.addFinalizer(() =>
        writer ? Effect.promise(() => writer!.close()) : Effect.void,
      );
      const findStage = async () => {
        const names = await NodeFSP.readdir(units);
        return NodePath.join(units, names[0]!, "stage.sqlite");
      };
      const observe: Statement.Transformer = (statement) => {
        const query = statement.compile()[0];
        if (
          changed ||
          !(kind === "retained-writer"
            ? query.includes("CREATE TABLE t3i_expected")
            : query.startsWith("ATTACH DATABASE"))
        )
          return Effect.succeed(statement);
        return Effect.promise(async () => {
          changed = true;
          stagePath = await findStage();
          if (kind === "retained-writer") {
            writer = await NodeFSP.open(stagePath, "r+");
            return;
          }
          if (kind === "directory") {
            const directory = NodePath.dirname(stagePath);
            await NodeFSP.rename(directory, directory + ".moved");
            await NodeFSP.mkdir(directory, { mode: 0o700 });
            await NodeFSP.copyFile(NodePath.join(directory + ".moved", "stage.sqlite"), stagePath);
          } else {
            await NodeFSP.copyFile(stagePath, stagePath + ".decoy");
            await NodeFSP.rename(stagePath, stagePath + ".original");
            if (kind === "symlink") await NodeFSP.symlink(stagePath + ".decoy", stagePath);
            else await NodeFSP.rename(stagePath + ".decoy", stagePath);
          }
        }).pipe(Effect.as(statement));
      };
      const h = yield* harness().pipe(
        Effect.provideService(T3ImportService.ImportHooks, {
          milestone: (stage) =>
            stage === "after-unit-staging" && kind === "same-inode"
              ? Effect.promise(async () => {
                  stagePath = await findStage();
                  changed = true;
                  await NodeFSP.chmod(stagePath, 0o600);
                  const file = await NodeFSP.open(stagePath, "r+");
                  try {
                    await file.write(Buffer.from([42]), 0, 1, 100);
                  } finally {
                    await file.close();
                  }
                  await NodeFSP.chmod(stagePath, 0o400);
                })
              : Effect.void,
        }),
      );
      yield* h.source.apply("thread.created", "thread:binding", sourceThread("thread:binding"));
      yield* h.source.apply(
        "turn-item.updated",
        "thread:binding",
        sourceItem("item:binding", "thread:binding"),
      );
      const { sessionId } = yield* h.importer.open({ sourceHome: h.source.home });
      units = NodePath.join(h.config.stateDir, "imports", "t3", "sessions", sessionId, "units");
      yield* h.importer.awaitReady(sessionId);
      const preview = yield* h.importer.preview({
        sessionId,
        selection: selection(["thread:binding"]),
      });
      const { jobId } = yield* h.importer
        .start({ sessionId, planId: preview.planId })
        .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
      yield* h.importer.awaitJob(jobId);
      const result = yield* h.importer.getJob({ jobId });
      assert.isTrue(changed);
      assert.equal(result.results[0]?.outcome, "failed");
      assert.equal(result.results[0]?.reason, "staging-failed");
      assert.deepStrictEqual(yield* h.sql`SELECT 1 FROM orchestration_v2_projection_threads`, []);
      assert.deepStrictEqual(
        yield* h.sql`SELECT 1 FROM pragma_database_list WHERE name = 't3i_unit'`,
        [],
      );
      yield* h.importer.close({ sessionId });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["assets", "unitAssetBytes", "jobAssetBytes", "ownershipBytes"] as const)(
  "keeps the exact small %s budget and blocks cap+1",
  (domain) =>
    Effect.gen(function* () {
      const maximum =
        domain === "assets"
          ? 1
          : domain === "ownershipBytes"
            ? Buffer.byteLength(
                JSON.stringify([
                  destinationId("transfer:fork", [
                    "environment:synthetic-t3",
                    "thread:golden:fork",
                    1,
                  ]),
                ]),
              )
            : 27;
      for (const excess of [false, true])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness().pipe(
              Effect.provideService(ImportLimits, {
                ...IMPORT_LIMITS,
                [domain]: maximum - (excess ? 1 : 0),
              }),
            );
            const { root, fork } = yield* goldenSource(h);
            const opened = yield* h.importer.open({ sourceHome: h.source.home });
            yield* h.importer.awaitReady(opened.sessionId);
            const preview = yield* h.importer.preview({
              sessionId: opened.sessionId,
              selection: selection([root, fork]),
            });
            assert.equal((preview.totals.blocked ?? 0) > 0, excess);
            if (!excess) {
              const started = yield* h.importer.start({
                sessionId: opened.sessionId,
                planId: preview.planId,
              });
              yield* h.importer.awaitJob(started.jobId);
              assert.isTrue(
                (yield* h.importer.getJob(started)).results.every(
                  (result) => result.outcome === "imported",
                ),
              );
            }
          }),
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("revalidates the auxiliary owner inode before startup reconciliation or purge", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Scope.close(h.importerScope, Exit.void);
    const directory = NodePath.join(h.config.stateDir, "imports", "t3");
    const sessions = NodePath.join(directory, "sessions");
    yield* Effect.promise(() => NodeFSP.mkdir(sessions, { recursive: true, mode: 0o700 }));
    const marker = NodePath.join(sessions, "private-marker");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(marker, "Synthetic untouched session", { mode: 0o600 }),
    );
    const target = NodePath.join(h.directory, "replacement-owner.sqlite");
    yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(target);
      db.exec("CREATE TABLE synthetic(value TEXT)");
      db.close();
    });
    const owner = NodePath.join(directory, "owner.sqlite");
    yield* Effect.promise(() => NodeFSP.rm(owner));
    yield* Effect.promise(() => NodeFSP.symlink(target, owner));
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const constructed = yield* h.newImporter(scope).pipe(Effect.result);
    assert.equal(constructed._tag, "Failure");
    assert.equal(
      yield* Effect.promise(() => NodeFSP.readFile(marker, "utf8")),
      "Synthetic untouched session",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
