import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  CheckpointId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ModelSelection,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { makeOmpAdapterV2 } from "./adapter.ts";
import { makeFakeOmp } from "./adapter.testkit.ts";
import { normalizeOmpModels } from "./status.ts";
import { OmpSettings } from "../settings.ts";

const decode = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        direction: Schema.String,
        frame: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  ),
);
const decodeSettings = Schema.decodeSync(OmpSettings);
const OMP_INSTANCE_ID = ProviderInstanceId.make("oh-my-pi");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("session-omp-test");
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/tmp",
} as const;
const modelSelection = (model = "default"): ModelSelection => ({
  instanceId: OMP_INSTANCE_ID,
  model,
  options: [],
});
const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const openRuntime = Effect.fn("OmpTest.openRuntime")(function* (
  fake: Effect.Success<ReturnType<typeof makeFakeOmp>>,
  continuationRequests?: Parameters<typeof makeOmpAdapterV2>[0]["continuationRequests"],
) {
  const adapter = yield* makeOmpAdapterV2({
    instanceId: OMP_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
    environment: {},
    ...(continuationRequests ? { continuationRequests } : {}),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: modelSelection(),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});
const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "Omp test thread",
    providerInstanceId: OMP_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello omp",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  continuation = false,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("oh-my-pi native adapter", () => {
  it.effect("explains an unavailable model through the normalized turn-start failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
      });
      fake.heldRequests.add("set_model");
      const turn = yield* startTurn(runtime, providerThread, "openai-codex/missing").pipe(
        Effect.forkScoped,
      );
      const request = yield* fake.takeRequest("set_model");
      yield* fake.emit({
        type: "response",
        id: request.id,
        command: "set_model",
        success: false,
        error: "Model not found",
      });
      const result = yield* Fiber.await(turn);
      assert.isTrue(Exit.isFailure(result));
      if (!Exit.isFailure(result)) return;
      assert.equal(
        makeProviderFailure({ cause: result.cause }).message,
        'Model "openai-codex/missing" is not available in oh-my-pi. Check omp sign-in and enabledModels, then choose an available model.',
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("replays real multi-turn output and retains the native handle after resume", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFileString(
        new URL("./fixtures/simple-multiple-turns.json", import.meta.url).pathname,
      );

      const recording = decode(raw);

      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake);
      let providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
      });
      for (let n = 0; n < 2; n++) {
        const start = recording.findIndex(
          (entry) => entry.direction === "out" && entry.frame.id === `capture-${n}`,
        );
        const end = recording.findIndex(
          (entry, index) => index > start && entry.frame.type === "prompt_result",
        );
        fake.scripts.push(
          recording
            .slice(start + 1, end + 1)
            .filter((entry) => entry.direction === "in" && entry.frame.type !== "response")
            .map((entry) => entry.frame),
        );
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          String(recording[start]!.frame.message),
          undefined,
          n + 1,
        );
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
        const resume = yield* runtime.resumeThread({ providerThread });
        assert.equal(resume.nativeThreadRef?.nativeId, providerThread.nativeThreadRef?.nativeId);
        providerThread = resume;
      }
      assert.equal(fake.outbound.filter((entry) => entry.type === "prompt").length, 2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("correlates completion, preserves native choices and closes tools on early Stop", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake);

      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
      });

      yield* startTurn(runtime, thread);

      const prompt = yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "write",
        args: { path: "test.txt", content: "x" },
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "approval",
        method: "select",
        title: "Allow tool: write",
        options: ["Approve", "Approve write for this session", "Deny"],
      });
      const event = yield* takeEvent((e) => e.type === "runtime_request.updated");
      assert.equal(event.type, "runtime_request.updated");
      if (event.type !== "runtime_request.updated") return;
      yield* runtime.respondToRuntimeRequest({
        requestId: event.runtimeRequest.id,
        answers: { approval: "Deny" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response.value, "Deny");
      yield* fake.emit({
        type: "prompt_result",
        id: "unrelated",
        status: "completed",
        sessionSettled: true,
      });
      if (event.runtimeRequest.providerTurnId === null) return;
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: event.runtimeRequest.providerTurnId,
      });
      yield* fake.takeRequest("abort_and_restore_queue");
      yield* fake.emit({
        type: "prompt_result",
        id: prompt.id,
        status: "aborted",
        sessionSettled: true,
      });
      const tool = yield* takeEvent(
        (e) =>
          e.type === "turn_item.updated" &&
          e.turnItem.type === "file_change" &&
          e.turnItem.completedAt !== null,
      );
      assert.equal(tool.type, "turn_item.updated");
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "restores default, rejects failed resumes, and uses the preceding inclusive fork boundary",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp();
        const { runtime, takeEvent } = yield* openRuntime(fake);
        let thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
        });
        for (const [n, model] of ["custom/model", "default"].entries()) {
          fake.scripts.push([{ type: "prompt_result", status: "completed", sessionSettled: true }]);
          yield* startTurn(runtime, thread, model, [], "Hello", undefined, n + 1);
          yield* takeEvent((e) => e.type === "turn.terminal");
        }
        assert.deepInclude(
          fake.outbound.findLast((record) => record.type === "set_model"),
          { provider: "openai-codex", modelId: "gpt-6-luna" },
        );
        fake.cancelNextSwitch();
        assert.isTrue(
          (yield* runtime.resumeThread({ providerThread: thread }).pipe(Effect.result))._tag ===
            "Failure",
        );
        thread = yield* runtime.resumeThread({ providerThread: thread });
        fake.setEntries(
          [
            {
              type: "message",
              id: "u1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00Z",
              message: { role: "user", content: [] },
            },
            {
              type: "message",
              id: "a1",
              parentId: "u1",
              timestamp: "2026-01-01T00:00:01Z",
              message: { role: "assistant", content: [] },
            },
            {
              type: "message",
              id: "u2",
              parentId: "a1",
              timestamp: "2026-01-01T00:00:02Z",
              message: { role: "user", content: [] },
            },
          ],
          "u2",
        );
        const at = yield* DateTime.now;
        const first = {
          id: "turn-1" as never,
          providerThreadId: thread.id,
          nodeId: "node-1" as never,
          runAttemptId: null,
          nativeTurnRef: { driver: runtime.driver, nativeId: "u1", strength: "strong" as const },
          ordinal: 1,
          status: "completed" as const,
          startedAt: at,
          completedAt: at,
        };
        const second = {
          ...first,
          id: "turn-2" as never,
          ordinal: 2,
          nativeTurnRef: { ...first.nativeTurnRef, nativeId: "u2" },
        };
        yield* runtime.rollbackThread({
          providerThread: thread,
          providerThreadTurns: [first, second],
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("cp"),
            appRunOrdinal: 1,
            providerTurn: first,
          },
        });
        assert.equal(fake.outbound.findLast((r) => r.type === "fork")?.entryId, "a1");
        const empty = yield* runtime.rollbackThread({
          providerThread: thread,
          providerThreadTurns: [first, second],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("start"),
            appRunOrdinal: 0,
          },
        });
        assert.equal(fake.outbound.findLast((r) => r.type === "branch")?.entryId, "u1");
        assert.deepEqual(empty.messages, []);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["completed", "failed", "cancelled"] as const)(
    "settles a recorded backgrounded bash command as %s on a tool update",
    (status) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const recording = decode(
          yield* fs.readFileString(
            new URL("./fixtures/steering-queued.json", import.meta.url).pathname,
          ),
        );
        const [start, handoff, progress, completion] = [61, 68, 89, 90].map(
          (frame) => recording[frame - 1]!.frame,
        );
        const fake = yield* makeFakeOmp();
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
        });

        yield* startTurn(runtime, thread);
        const prompt = yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        for (const frame of [start!, handoff!, progress!]) yield* fake.emit(frame);
        const boundedOutput =
          status === "failed" ? "Command exited with code 1" : "Command cancelled";
        yield* fake.emit(
          status === "completed"
            ? completion!
            : {
                type: "tool_execution_update",
                toolCallId: start!.toolCallId,
                toolName: "bash",
                partialResult: {
                  content: [{ type: "text", text: boundedOutput }],
                  details: {
                    async: { state: status, jobId: "bg_1", type: "bash" },
                    ...(status === "failed" ? { exitCode: 1 } : {}),
                  },
                },
              },
        );
        yield* fake.emit(progress!);
        yield* fake.emit({
          type: "prompt_result",
          id: prompt.id,
          status: "completed",
          sessionSettled: true,
        });

        const items: Array<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = [];
        const nodes: OrchestrationV2ExecutionNode[] = [];
        yield* takeEvent((event) => {
          if (
            event.type === "node.updated" &&
            event.node.nativeItemRef?.nativeId === start!.toolCallId
          ) {
            nodes.push(event.node);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            items.push(event.turnItem);
          }
          return event.type === "turn.terminal";
        });
        assert.deepEqual(
          items.map((item) => item.status),
          ["running", "running", "running", status],
        );
        assert.deepEqual(
          nodes.map((node) => node.status),
          items.map((item) => item.status),
        );
        const [initial, backgrounded, running, settled] = items;
        assert.include(backgrounded?.output, "Backgrounded as job bg_1");
        assert.equal(running?.output, "ORIGINAL");
        assert.equal(
          settled?.output,
          status === "completed" ? "ORIGINAL\n\nWall time: 2.02 seconds" : boundedOutput,
        );
        assert.equal(settled?.exitCode, status === "failed" ? 1 : undefined);
        assert.isNotNull(settled?.completedAt);
        for (const item of items) {
          assert.equal(item.id, initial?.id);
          assert.equal(item.input, "sleep 2; printf ORIGINAL");
          assert.deepEqual(item.startedAt, initial?.startedAt);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { exitCode: 0, status: "completed" },
    { exitCode: 1, status: "failed" },
  ] as const)("settles a synchronous bash command as $status", ({ exitCode, status }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
      });
      yield* startTurn(runtime, thread);
      const prompt = yield* fake.takeRequest("prompt");
      const toolCall = { toolCallId: "sync-bash", toolName: "bash" };
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "tool_execution_start", ...toolCall, args: { command: "fixture" } });
      const output = `Fixture exit ${exitCode}`;
      yield* fake.emit({
        type: "tool_execution_end",
        ...toolCall,
        isError: exitCode !== 0,
        result: { content: [{ type: "text", text: output }], details: { exitCode } },
      });
      yield* fake.emit({
        type: "prompt_result",
        id: prompt.id,
        status: "completed",
        sessionSettled: true,
      });
      const commands: Array<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = [];
      yield* takeEvent((event) => {
        if (event.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
          commands.push(event.turnItem);
        }
        return event.type === "turn.terminal";
      });
      assert.deepEqual(
        commands.map((item) => item.status),
        ["running", status],
      );
      assert.include(commands[1]!, { id: commands[0]!.id, input: "fixture", output, exitCode });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["completed", "missing terminal update", "stopped wake"] as const)(
    "keeps late native work on its original run (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const recording = decode(
          yield* fs.readFileString(
            new URL("./fixtures/background-child.json", import.meta.url).pathname,
          ),
        );

        const fake = yield* makeFakeOmp();
        const wakes =
          yield* Queue.unbounded<
            import("@t3tools/provider-core/server/ProviderContinuationRequests").ProviderContinuationRequest
          >();

        const { runtime, takeEvent } = yield* openRuntime(fake, {
          offer: (request) => Queue.offer(wakes, request).pipe(Effect.asVoid),
        });

        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
        });
        const start = recording.findIndex((entry) => entry.frame.type === "prompt");
        const end = scenario === "stopped wake" ? 100 : recording.length;
        fake.scripts.push(
          recording
            .slice(start + 1, end)
            .filter(
              (entry, index) =>
                entry.direction === "in" &&
                entry.frame.type !== "response" &&
                // Leave session_settled as the continuation's finalization signal when frame 99 is absent.
                (scenario === "completed" || ![99, 113].includes(start + index + 2)),
            )
            .map((entry) => entry.frame),
        );
        const taskCallId = recording[73]!.frame.toolCallId;
        const taskItems: Array<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = [];
        const taskNodes: OrchestrationV2ExecutionNode[] = [];
        const takeLifecycleEvent = (predicate: Parameters<typeof takeEvent>[0]) =>
          takeEvent((event) => {
            if (
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === taskCallId
            ) {
              taskNodes.push(event.node);
            }
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === taskCallId
            ) {
              taskItems.push(event.turnItem);
            }
            return predicate(event);
          });

        yield* startTurn(runtime, thread);

        const root = yield* takeLifecycleEvent((e) => e.type === "turn.terminal");
        assert.equal(root.type === "turn.terminal" && root.status, "completed");
        const group = (item: (typeof taskItems)[number]) =>
          derivePendingBackgroundWork({
            latestRun: { id: RunId.make(`run:${THREAD_ID}:1`), ordinal: 1, status: "completed" },
            providerThreads: [],
            turnItems: [item],
          });
        assert.lengthOf(group(taskItems.at(-1)!), 1);

        const wake = yield* Queue.take(wakes);

        assert.equal(wake.providerThreadId, thread.id);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        if (scenario === "stopped wake") {
          yield* wake.clearIfCurrent!();
          yield* takeLifecycleEvent(
            (e) => e.type === "provider_session.updated" && e.providerSession.status === "stopped",
          );
        } else {
          yield* startTurn(runtime, thread, "default", [], "", undefined, 2, THREAD_ID, true);

          const child = yield* takeLifecycleEvent(
            (e) => e.type === "subagent.updated" && e.subagent.status === "completed",
          );
          assert.equal(
            child.type === "subagent.updated" && child.subagent.runId,
            RunId.make(`run:${THREAD_ID}:1`),
          );
          const continuation = yield* takeLifecycleEvent((e) => e.type === "turn.terminal");
          assert.equal(continuation.type === "turn.terminal" && continuation.status, "completed");
          assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        }

        const settled = taskItems.at(-1)!;
        const status =
          scenario === "completed"
            ? "completed"
            : scenario === "stopped wake"
              ? "interrupted"
              : "failed";
        assert.equal(settled.status, status);
        assert.deepEqual(
          taskItems.filter((item) => item.status !== "running"),
          [settled],
        );
        assert.deepEqual(
          taskNodes.filter((node) => node.status !== "running").map((node) => node.status),
          [status],
        );
        assert.equal(settled.runId, RunId.make(`run:${THREAD_ID}:1`));
        assert.isNotNull(settled.completedAt);
        assert.deepEqual(group(settled), []);
        if (scenario === "completed") {
          assert.equal(settled.output, "Background task ChildDone complete.");
        } else {
          assert.deepEqual(settled.output, taskItems.at(-2)?.output);
        }

        assert.equal(fake.outbound.filter((entry) => entry.type === "prompt").length, 1);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "replays recorded native allow, deny and question dialogs without changing their choices",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const recording = decode(
          yield* fs.readFileString(
            new URL("./fixtures/approvals-question-interrupt.json", import.meta.url).pathname,
          ),
        );
        const fake = yield* makeFakeOmp();
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
        });
        for (const [index, scenario] of ["approval-allow", "approval-deny", "question"].entries()) {
          const start = recording.findIndex(
            (entry) =>
              entry.direction === "out" &&
              entry.frame.type === "prompt" &&
              entry.frame.id === scenario,
          );
          const end = recording.findIndex(
            (entry, n) => n > start && entry.frame.type === "prompt_result",
          );
          const segment = recording.slice(start + 1, end + 1);
          const dialog = segment.find(
            (entry) =>
              entry.direction === "in" &&
              entry.frame.type === "extension_ui_request" &&
              entry.frame.method === "select",
          )!.frame;
          const answer = segment.find(
            (entry) =>
              entry.direction === "out" &&
              entry.frame.type === "extension_ui_response" &&
              entry.frame.id === dialog.id,
          )!.frame.value;
          fake.scripts.push(
            segment
              .filter((entry) => entry.direction === "in" && entry.frame.type !== "response")
              .map((entry) => entry.frame),
          );
          yield* startTurn(
            runtime,
            thread,
            "default",
            [],
            String(recording[start]!.frame.message),
            undefined,
            index + 1,
          );
          const request = yield* takeEvent(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          if (request.type !== "runtime_request.updated") return;
          yield* runtime.respondToRuntimeRequest({
            requestId: request.runtimeRequest.id,
            answers: { [String(dialog.id)]: String(answer) },
          });
          const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
        }
        assert.deepEqual(
          fake.outbound
            .filter((entry) => entry.type === "extension_ui_response")
            .map((entry) => entry.value),
          ["Approve", "Deny", "Blue"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("normalizes OMP automatic compaction events and preserves the running prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
      });
      yield* startTurn(runtime, thread);
      const prompt = yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "auto_compaction_start", reason: "threshold" });
      yield* fake.emit({
        type: "auto_compaction_end",
        aborted: false,
        skipped: true,
        errorMessage: "Nothing to compact",
      });
      const compact = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      assert.equal(compact.type, "turn_item.updated");
      yield* fake.emit({
        type: "prompt_result",
        id: prompt.id,
        status: "completed",
        sessionSettled: true,
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it("defaults to disabled and reads OMP thinking metadata without Pi tiers", () => {
    assert.equal(decodeSettings({}).enabled, false);
    assert.deepEqual(normalizeOmpModels({ models: [] }), []);
    const [model] = normalizeOmpModels({
      models: [
        {
          provider: "provider/name",
          id: "model/id",
          reasoning: true,
          thinking: { efforts: ["low", "max"] },
        },
      ],
    });
    assert.equal(model?.slug, "provider/name/model/id");
    assert.deepEqual(
      model?.capabilities?.optionDescriptors?.map((d) => d.id),
      ["thinking"],
    );
  });
});
