import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeFakeOmp } from "./adapter.testkit.ts";
import { makeOmpRpcConnection } from "./rpc.ts";

describe("OMP RPC requests", () => {
  it.effect(
    "cancels one request without retiring the transport and fails outstanding requests on exit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "u4-omp-rpc-" });
        const fake = yield* makeFakeOmp();
        const rpc = yield* makeOmpRpcConnection({
          command: "omp",
          args: ["--mode", "rpc-ui", "--session-dir", dir],
          cwd: dir,
          env: {},
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
        fake.heldRequests.add("held");
        const cancelled = yield* rpc.request({ type: "held" }).pipe(Effect.forkScoped);
        yield* fake.takeRequest("held");
        yield* Fiber.interrupt(cancelled);
        const state = yield* rpc.request({ type: "get_state" });
        assert.isObject(state);
        const pending = yield* rpc.request({ type: "held" }).pipe(Effect.forkScoped);
        yield* fake.takeRequest("held");
        yield* fake.close;
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
