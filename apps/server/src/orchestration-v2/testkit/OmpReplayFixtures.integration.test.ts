import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayTranscript } from "@t3tools/contracts";
import { OMP_PROVIDER } from "@u4code/provider-oh-my-pi/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { OmpOrchestratorReplayHarness } from "../Adapters/OmpAdapterV2.testkit.ts";
import { type OrchestratorFixtureInputStep, materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";

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

describe("oh-my-pi real native recordings", () => {
  it.effect(
    "projects and checkpoints a two-turn conversation through orchestration and persistence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const recording = decode(
          yield* fs.readFileString(
            new URL(
              "../../../../../packages/provider-oh-my-pi/src/server/fixtures/simple-multiple-turns.json",
              import.meta.url,
            ).pathname,
          ),
        );
        const transcript: ProviderReplayTranscript = {
          provider: OMP_PROVIDER,
          protocol: "omp.rpc-jsonl",
          version: "18.14.1",
          scenario: "omp-real-multi-turn",
          entries: recording.map((entry) => ({
            type: entry.direction === "out" ? "expect_outbound" : "emit_inbound",
            frame: entry.frame,
          })),
        };
        const modelSelection = {
          instanceId: ProviderInstanceId.make(OMP_PROVIDER),
          model: "default",
          options: [],
        };
        const fixtureInput = {
          steps: recording
            .filter((entry) => entry.direction === "out" && entry.frame.type === "prompt")
            .map((entry) => ({ type: "message" as const, text: String(entry.frame.message) })),
        };
        const workspace = yield* checkpointWorkspace("omp-real-multi-turn");
        const materialized = yield* materializeFixtureInput({
          scenario: "omp-real-multi-turn",
          fixtureInput,
          driver: OMP_PROVIDER,
          modelSelection,
        }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
        const result = yield* runOrchestratorV2ProviderReplayScenario(
          {
            name: transcript.scenario,
            transcript,
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { cwd: workspace },
          },
          OmpOrchestratorReplayHarness,
        ).pipe(provideDeterministicTestRuntime);
        const projection = result.projections.get(materialized.projectionThreadIds[0]!);
        assert.isDefined(projection);
        assert.deepEqual(
          projection!.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.deepEqual(
          projection!.messages.filter((m) => m.role === "assistant").map((m) => m.text),
          ["OMP_NATIVE_OK", "OMP_NATIVE_OK"],
        );
        assert.equal(projection!.providerThreads[0]?.driver, OMP_PROVIDER);
        assert.isAtLeast(projection!.checkpoints.length, 2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("routes native allow, deny and question responses through orchestration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const recording = decode(
        yield* fs.readFileString(
          new URL(
            "../../../../../packages/provider-oh-my-pi/src/server/fixtures/approvals-question-interrupt.json",
            import.meta.url,
          ).pathname,
        ),
      );
      const limit = recording.findIndex(
        (entry) => entry.frame.type === "prompt_result" && entry.frame.id === "question",
      );
      const selected = recording.slice(0, limit + 1);
      const steps: OrchestratorFixtureInputStep[] = [];
      for (const entry of selected) {
        if (entry.direction === "out" && entry.frame.type === "prompt")
          steps.push({ type: "message", text: String(entry.frame.message) });
        if (entry.direction === "out" && entry.frame.type === "extension_ui_response")
          steps.push({
            type: "answer_next_user_input_request",
            answers: { [String(entry.frame.id)]: String(entry.frame.value) },
          });
      }
      const transcript: ProviderReplayTranscript = {
        provider: OMP_PROVIDER,
        protocol: "omp.rpc-jsonl",
        version: "18.14.1",
        scenario: "omp-real-dialogs",
        entries: selected.map((entry) => ({
          type: entry.direction === "out" ? "expect_outbound" : "emit_inbound",
          frame: entry.frame,
        })),
      };
      const modelSelection = {
        instanceId: ProviderInstanceId.make(OMP_PROVIDER),
        model: "default",
        options: [],
      };
      const workspace = yield* checkpointWorkspace(transcript.scenario);
      const materialized = yield* materializeFixtureInput({
        scenario: transcript.scenario,
        fixtureInput: { steps },
        driver: OMP_PROVIDER,
        modelSelection,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: transcript.scenario,
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd: workspace },
        },
        OmpOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const projection = result.projections.get(materialized.projectionThreadIds[0]!)!;
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed", "completed"],
      );
      assert.deepEqual(
        projection.runtimeRequests.map((request) => request.status),
        ["resolved", "resolved", "resolved"],
      );
      assert.equal(projection.messages.filter((m) => m.role === "assistant").at(-1)?.text, "Blue");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
