import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { OmpRpcRecord } from "./rpc.ts";

const decode = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const TEST_MODEL = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  contextWindow: 272000,
  reasoning: true,
  thinking: { efforts: ["low", "medium", "high", "max"] },
};

export const makeFakeOmp = Effect.fn("makeFakeOmp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const requests = yield* Queue.unbounded<OmpRpcRecord>();
  const outbound: OmpRpcRecord[] = [];
  const heldRequests = new Set<string>();
  const dialogs = new Map<string, Deferred.Deferred<void>>();
  const scope = yield* Effect.scope;
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  let stdout: Queue.Queue<Uint8Array, Cause.Done>;
  let sessionDir = "";
  let sessionFile = "";
  let sessionNumber = 0;
  let model = TEST_MODEL;
  let thinking = "low";
  let entries: OmpRpcRecord[] = [];
  let leafId: string | null = null;
  let cancelSwitch = false;
  const scripts: OmpRpcRecord[][] = [];
  const emit = (record: OmpRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encode(record)}\n`)).pipe(Effect.asVoid);
  const newSession = Effect.fn("FakeOmp.newSession")(function* (cwd: string) {
    sessionFile = `${sessionDir}/session-${++sessionNumber}.jsonl`;
    yield* fs.writeFileString(
      sessionFile,
      encode({ type: "session", id: `session-${sessionNumber}`, cwd }) + "\n",
    );
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("Expected standard command");
      const args = command.args.map(String);
      sessionDir = args[args.indexOf("--session-dir") + 1]!;
      const cwd = command.options.cwd ?? "/tmp";
      yield* fs.makeDirectory(sessionDir, { recursive: true });
      yield* newSession(cwd);
      stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      yield* emit({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1048576,
        maxReassembledFrameBytes: 67108864,
      });
      let buffer = "";
      const handle = Effect.fn("FakeOmp.input")(function* (chunk: Uint8Array) {
        buffer += new TextDecoder().decode(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const record = decode(line);
          outbound.push(record);
          yield* Queue.offer(requests, record);
          let data: unknown = {};
          switch (record.type) {
            case "extension_ui_response": {
              const pending = dialogs.get(String(record.id));
              if (pending) {
                yield* Deferred.succeed(pending, undefined);
                dialogs.delete(String(record.id));
              }
              break;
            }
            case "get_state":
              data = {
                model,
                thinkingLevel: thinking,
                sessionFile,
                sessionId: `session-${sessionNumber}`,
                isStreaming: false,
                isCompacting: false,
                hasPendingAsyncWork: false,
                isSettled: true,
              };
              break;
            case "set_model":
              model = {
                ...TEST_MODEL,
                provider: String(record.provider),
                id: String(record.modelId),
              };
              data = model;
              break;
            case "get_available_models":
              data = { models: [TEST_MODEL] };
              break;
            case "get_available_thinking_levels":
              data = { levels: ["off", ...model.thinking.efforts] };
              break;
            case "set_thinking_level":
              thinking = String(record.level);
              break;
            case "get_entries":
              data = { entries, leafId };
              break;
            case "get_messages":
              data = {
                messages: entries
                  .filter((entry) => entry.type === "message")
                  .map((entry) => entry.message),
              };
              break;
            case "get_session_stats":
              data = {
                tokens: { input: 10, output: 5, cacheRead: 0 },
                contextUsage: { tokens: 15, contextWindow: 272000 },
              };
              break;
            case "switch_session":
              if (!cancelSwitch) sessionFile = String(record.sessionPath);
              data = { cancelled: cancelSwitch };
              cancelSwitch = false;
              break;
            case "new_session":
              entries = [];
              leafId = null;
              yield* newSession(cwd);
              data = { cancelled: false };
              break;
            case "branch":
            case "fork": {
              const at = entries.findIndex((entry) => entry.id === record.entryId);
              if (at >= 0) {
                entries = entries.slice(0, record.type === "branch" ? at : at + 1);
                leafId =
                  record.type === "branch"
                    ? ((entries.at(-1)?.id as string | undefined) ?? null)
                    : String(record.entryId);
              }
              yield* newSession(cwd);
              data = { cancelled: false };
              break;
            }
          }
          if (record.id && !heldRequests.has(String(record.type)))
            yield* emit({
              type: "response",
              id: record.id,
              command: record.type,
              success: true,
              data,
            });
          if (record.type === "prompt") {
            const script = scripts.shift();
            if (script)
              yield* Effect.gen(function* () {
                for (const frame of script) {
                  const dialog =
                    frame.type === "extension_ui_request" &&
                    ["select", "confirm", "input", "editor"].includes(String(frame.method))
                      ? yield* Deferred.make<void>()
                      : undefined;
                  if (dialog) dialogs.set(String(frame.id), dialog);
                  yield* emit(frame.type === "prompt_result" ? { ...frame, id: record.id } : frame);
                  if (dialog) yield* Deferred.await(dialog);
                }
              }).pipe(Effect.forkIn(scope));
          }
        }
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999999999),
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handle),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    spawner,
    heldRequests,
    emit,
    outbound,
    scripts,
    takeRequest: (type: string) =>
      Effect.gen(function* () {
        while (true) {
          const entry = yield* Queue.take(requests);
          if (entry.type === type) return entry;
        }
      }),
    setEntries: (value: OmpRpcRecord[], leaf: string | null) => {
      entries = value;
      leafId = leaf;
    },
    cancelNextSwitch: () => {
      cancelSwitch = true;
    },
    close: Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
      Effect.andThen(Effect.suspend(() => Queue.end(stdout))),
    ),
  };
});
