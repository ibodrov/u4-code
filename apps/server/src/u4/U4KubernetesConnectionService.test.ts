import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { U4ClusterProfile, U4KubernetesWorkspace } from "@t3tools/contracts";
import * as Connections from "./U4KubernetesConnectionService.ts";
import * as Kubectl from "./U4KubectlClient.ts";
import { workspaceLabels } from "./workspaceResources.ts";
const profile = { context: "owned-context", namespace: "owned-namespace" } as U4ClusterProfile;
const workspace = {
  id: "ws-test",
  podName: "ws-test-1",
  podUid: "uid",
  ownerId: "owner",
  environmentId: "environment",
  route: null,
} as U4KubernetesWorkspace;
function fixture() {
  return Effect.gen(function* () {
    const spawned = yield* Queue.unbounded<ChildProcess.Command>();
    const closed = yield* Queue.unbounded<void>();
    const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
    let uid = "uid";
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          exits.push(exit);
          yield* Queue.offer(spawned, command);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            exitCode: Deferred.await(exit),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.concat(
              Stream.make(new TextEncoder().encode("Forwarding from 127.0.0.1:12345 -> 4773\n")),
              Stream.never,
            ),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
        () => Queue.offer(closed, undefined),
      ),
    );
    const layer = Connections.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.mock(Kubectl.U4KubectlClient)({
            run: (_p, args) =>
              Effect.succeed(
                args[0] === "get"
                  ? JSON.stringify({
                      metadata: {
                        name: workspace.podName,
                        uid,
                        labels: workspaceLabels(workspace),
                      },
                      spec: {},
                      status: {},
                    })
                  : args.at(-1) === "/state/u4/userdata/environment-id"
                    ? "environment\n"
                    : "Token: fixture-only\n",
              ),
          }),
        ),
      ),
    );
    return {
      layer,
      spawned,
      closed,
      exits,
      setUid: (value: string) => {
        uid = value;
      },
    };
  });
}
it.effect(
  "limits local bootstrap to manager-local browsers and closes explicit, expiring and shutdown forwards",
  () =>
    Effect.gen(function* () {
      for (const c of [
        { ipAddress: "100.1.1.1", origin: "http://localhost:1" },
        { ipAddress: "127.0.0.1", origin: "https://remote.example" },
        { origin: "http://localhost:1" },
      ])
        expect(Connections.isLocalBootstrapClient(c)).toBe(false);
      expect(
        Connections.isLocalBootstrapClient({
          ipAddress: "127.0.0.1",
          origin: "http://localhost:8544",
        }),
      ).toBe(true);
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const c = yield* Connections.U4KubernetesConnectionService;
        expect((yield* Effect.flip(c.pair(profile, workspace, "forward", false))).stage).toBe(
          "connection",
        );
        const first = yield* c.pair(profile, workspace, "forward", true);
        expect(first.route).toBe("http://127.0.0.1:12345");
        const command = yield* Queue.take(f.spawned);
        expect(command).toMatchObject({
          command: "kubectl",
          args: [
            "--context",
            "owned-context",
            "--namespace",
            "owned-namespace",
            "port-forward",
            "pod/ws-test-1",
            "0:4773",
            "--address",
            "127.0.0.1",
          ],
        });
        yield* c.stop(workspace.id);
        yield* Queue.take(f.closed);
        expect(yield* c.expiresAt(workspace.id)).toBeUndefined();
        yield* c.pair(profile, workspace, "forward", true);
        yield* Queue.take(f.spawned);
        yield* TestClock.adjust("30 minutes");
        yield* Queue.take(f.closed);
        expect(yield* c.expiresAt(workspace.id)).toBeUndefined();
        yield* c.pair(profile, workspace, "forward", true);
        yield* Queue.take(f.spawned);
      }).pipe(Effect.provide(f.layer));
      yield* Queue.take(f.closed);
    }),
);
it.effect(
  "reconnects the same loopback port and refuses a changed Pod UID before returning a route",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const c = yield* Connections.U4KubernetesConnectionService;
        yield* c.pair(profile, workspace, "forward", true);
        yield* Queue.take(f.spawned);
        yield* Deferred.succeed(f.exits[0]!, ChildProcessSpawner.ExitCode(1));
        yield* Queue.take(f.closed);
        yield* TestClock.adjust("1 second");
        expect(yield* Queue.take(f.spawned)).toMatchObject({
          args: [
            "--context",
            "owned-context",
            "--namespace",
            "owned-namespace",
            "port-forward",
            "pod/ws-test-1",
            "12345:4773",
            "--address",
            "127.0.0.1",
          ],
        });
        f.setUid("foreign");
        expect((yield* Effect.flip(c.pair(profile, workspace, "forward", true))).stage).toBe(
          "ownership",
        );
        yield* Queue.take(f.closed);
        expect(yield* c.expiresAt(workspace.id)).toBeUndefined();
      }).pipe(Effect.provide(f.layer));
    }),
);
