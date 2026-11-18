import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { ProviderInstanceId, type ProviderReplayTranscript } from "@t3tools/contracts";
import { OMP_PROVIDER, OmpAdapterV2Driver } from "@u4code/provider-oh-my-pi/server";
import { makeFakeOmp } from "@u4code/provider-oh-my-pi/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export const OmpOrchestratorReplayHarness = {
  driver: OMP_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) => Effect.succeed(transcript),
  makeProviderAdapterRegistryLayer: (transcript: ProviderReplayTranscript) =>
    ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp().pipe(Effect.orDie);
        let script: Record<string, unknown>[] | undefined;
        for (const entry of transcript.entries) {
          const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
          if (typeof frame !== "object" || frame === null || Array.isArray(frame)) continue;
          const record = frame as Record<string, unknown>;
          if (entry.type === "expect_outbound" && record.type === "prompt") {
            script = [];
            fake.scripts.push(script);
          } else if (entry.type === "emit_inbound" && script && record.type !== "response")
            script.push(record);
        }
        const adapter = yield* OmpAdapterV2Driver.create({
          instanceId: ProviderInstanceId.make(OMP_PROVIDER),
          displayName: undefined,
          enabled: true,
          environment: [],
          config: { ...OmpAdapterV2Driver.defaultConfig(), binaryPath: "omp", launchArgs: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
        return [adapter];
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerUndici,
          IdAllocator.layer,
          TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
} satisfies OrchestratorV2ProviderReplayHarness<
  ProviderReplayTranscript,
  import("@t3tools/provider-core/server/adapterDriver").ProviderAdapterDriverCreateError
>;
