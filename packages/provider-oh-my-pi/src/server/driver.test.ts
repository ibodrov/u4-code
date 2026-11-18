import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { OmpDriver } from "./driver.ts";

const decode = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
);

const makeDiscoverySpawner = () => {
  const requests: Record<string, unknown>[] = [];
  const launches: ChildProcess.StandardCommand[] = [];
  const inventory = {
    models: Array.from({ length: 700 }, (_, index) => ({
      provider: index % 2 ? "deepseek" : "openrouter",
      id: `model-${index}`,
      name: `Model ${index}`,
      description: "界".repeat(600),
      reasoning: true,
      thinking: { efforts: ["low", "high"] },
    })),
    error: undefined as string | undefined,
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const emit = (value: unknown) =>
        Queue.offer(stdout, encoder.encode(`${JSON.stringify(value)}\n`));
      if (!version) yield* emit({ type: "ready", supportedProtocolVersions: [1, 2] });
      let protocol = 1;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const request = decode(new TextDecoder().decode(chunk).trim());
            requests.push(request);
            if (request.type === "negotiate_protocol") protocol = Number(request.protocolVersion);
            const data =
              request.type === "get_available_models"
                ? { models: inventory.models }
                : request.type === "get_state"
                  ? { model: inventory.models[0] }
                  : {};
            const error = request.type === "get_available_models" ? inventory.error : undefined;
            const response = {
              type: "response",
              id: request.id,
              command: request.type,
              success: !error,
              ...(error ? { error } : { data }),
            };
            const bytes = Buffer.from(JSON.stringify(response));
            if (bytes.length < 1024 * 1024) {
              yield* emit(response);
              return;
            }
            if (protocol !== 2) {
              yield* emit({
                ...response,
                success: false,
                data: undefined,
                error: "RPC response exceeded the transport limit",
              });
              return;
            }
            const count = Math.ceil(bytes.length / (256 * 1024));
            for (let index = 0; index < count; index++) {
              yield* emit({
                type: "rpc_chunk",
                chunkId: String(request.id),
                index,
                count,
                byteLength: bytes.length,
                data: bytes
                  .subarray(index * 256 * 1024, (index + 1) * 256 * 1024)
                  .toString("base64"),
              });
            }
          }),
        ),
        stdout: version
          ? Stream.succeed(encoder.encode("omp/18.14.1\n"))
          : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, inventory, requests, launches };
};

it.effect(
  "discovers large catalogs at setup and refresh, preserving them after a failed refresh",
  () =>
    Effect.gen(function* () {
      const fake = makeDiscoverySpawner();
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-models"),
        displayName: "My OMP",
        enabled: true,
        environment: [],
        config: { ...OmpDriver.defaultConfig(), enabled: true },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      const initial = yield* instance.snapshot.getSnapshot;
      assert.equal(initial.models.length, 701);
      assert.equal(initial.models[1]?.slug, "openrouter/model-0");
      assert.equal(initial.auth.status, "authenticated");
      assert.deepEqual(
        fake.requests.slice(0, 2).map((request) => request.type),
        ["negotiate_protocol", "get_available_models"],
      );
      const requestCount = fake.requests.length;
      yield* instance.snapshot.refresh;
      assert.equal(fake.requests.length, requestCount);
      assert.isTrue(fake.launches.at(-1)!.args.includes("--version"));
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/project");
      assert.deepEqual(workspace.workspaceModels, initial.models);
      assert.isDefined(instance.refreshModels);
      yield* instance.refreshModels!();
      assert.deepEqual((yield* instance.snapshot.getSnapshot).models, initial.models);
      fake.inventory.models = fake.inventory.models.slice(0, 2);
      yield* instance.refreshModels!();
      const refreshed = yield* instance.snapshot.getSnapshot;
      assert.equal(refreshed.models.length, 3);
      fake.inventory.error = "RPC response exceeded the transport limit";
      assert.isTrue(Exit.isFailure(yield* Effect.exit(instance.refreshModels!())));
      yield* instance.snapshot.refresh;
      assert.deepEqual((yield* instance.snapshot.getSnapshot).models, refreshed.models);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
