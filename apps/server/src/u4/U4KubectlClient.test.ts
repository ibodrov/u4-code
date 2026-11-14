import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { U4ClusterProfile } from "@t3tools/contracts";
import * as Kubectl from "./U4KubectlClient.ts";
import * as ProcessRunner from "../processRunner.ts";
it.live(
  "bounds streamed downloads before EOF, supervises cancellation, preserves binary bytes and removes failed files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "u4-download-" });
      let mode = "oversize",
        closed = 0,
        received = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            expect(command).toMatchObject({
              command: "kubectl",
              args: [
                "--context",
                "context",
                "--namespace",
                "namespace",
                "exec",
                "pod",
                "--",
                "cat",
                "/workspace/result.bundle",
              ],
            });
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              exitCode:
                mode === "oversize"
                  ? Effect.never
                  : Effect.succeed(ChildProcessSpawner.ExitCode(mode === "exit" ? 1 : 0)),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout:
                mode === "oversize"
                  ? Stream.concat(
                      Stream.fromIterable([
                        new Uint8Array(5),
                        new Uint8Array(5),
                        new Uint8Array(5),
                      ]).pipe(
                        Stream.tap(() =>
                          Effect.sync(() => {
                            received++;
                          }),
                        ),
                      ),
                      Stream.never,
                    )
                  : Stream.make(new Uint8Array([0, 255, 13, 10])),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
          () =>
            Effect.sync(() => {
              closed++;
            }),
        ),
      );
      const layer = Layer.effect(Kubectl.U4KubectlClient, Kubectl.make).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProcessRunner.ProcessRunner)({}),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const client = yield* Kubectl.U4KubectlClient;
        const profile = { context: "context", namespace: "namespace" } as U4ClusterProfile;
        const args = ["exec", "pod", "--", "cat", "/workspace/result.bundle"];
        expect(
          (yield* Effect.flip(client.download(profile, args, `${directory}/too-big`, 10))).stage,
        ).toBe("transfer");
        expect(received).toBe(3);
        expect(closed).toBe(1);
        expect(yield* fs.exists(`${directory}/too-big`)).toBe(false);
        mode = "exit";
        expect(
          (yield* Effect.flip(client.download(profile, args, `${directory}/bad-exit`, 10))).stage,
        ).toBe("transfer");
        expect(yield* fs.exists(`${directory}/bad-exit`)).toBe(false);
        mode = "valid";
        yield* client.download(profile, args, `${directory}/valid`, 10);
        expect(Array.from(yield* fs.readFile(`${directory}/valid`))).toEqual([0, 255, 13, 10]);
        expect(closed).toBe(3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
