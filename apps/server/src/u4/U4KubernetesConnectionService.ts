import {
  U4WorkspaceError,
  type U4ClusterProfile,
  type U4KubernetesWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as U4KubectlClient from "./U4KubectlClient.ts";

export class U4KubernetesConnectionService extends Context.Service<
  U4KubernetesConnectionService,
  {
    readonly pair: (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
    ) => Effect.Effect<
      { environmentId: string; route: string | null; pairingCode: string },
      U4WorkspaceError
    >;
    readonly forward: (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
    ) => Effect.Effect<string, U4WorkspaceError, Scope.Scope>;
  }
>()("t3/u4/U4KubernetesConnectionService") {}
const make = Effect.gen(function* () {
  const kubectl = yield* U4KubectlClient.U4KubectlClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pair = Effect.fn("U4KubernetesConnectionService.pair")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const environmentId = (yield* kubectl.run(profile, [
      "exec",
      workspace.podName,
      "-c",
      "server",
      "--",
      "cat",
      "/state/u4/userdata/environment-id",
    ])).trim();
    if (
      !environmentId ||
      (workspace.environmentId !== null && workspace.environmentId !== environmentId)
    )
      return yield* new U4WorkspaceError({ stage: "ownership" });
    const output = yield* kubectl.run(profile, [
      "exec",
      workspace.podName,
      "-c",
      "server",
      "--",
      "/opt/u4/runtime/t3",
      "pair",
      "--base-dir",
      "/state/u4",
      "--label",
      "U4 Kubernetes workspace",
    ]);
    const pairingCode = /^Token: (\S+)$/m.exec(output)?.[1];
    if (!pairingCode) return yield* new U4WorkspaceError({ stage: "connection" });
    return { environmentId, route: workspace.route, pairingCode };
  });
  const forward = Effect.fn("U4KubernetesConnectionService.forward")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const ready = yield* Deferred.make<string, U4WorkspaceError>();
    const pod = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.Pod,
      yield* kubectl.run(profile, ["get", "pod", workspace.podName, "-o", "json"]),
    );
    if (pod.metadata.uid !== workspace.podUid || pod.metadata.deletionTimestamp)
      return yield* new U4WorkspaceError({ stage: "ownership" });
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          "kubectl",
          [
            "--context",
            profile.context,
            "--namespace",
            profile.namespace,
            "port-forward",
            `pod/${workspace.podName}`,
            "0:4773",
            "--address",
            "127.0.0.1",
          ],
          { stdin: "ignore" },
        ),
      )
      .pipe(Effect.mapError((cause) => new U4WorkspaceError({ stage: "connection", cause })));
    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const port = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(line)?.[1];
        return port
          ? Deferred.succeed(ready, `http://127.0.0.1:${port}`).pipe(Effect.asVoid)
          : Effect.void;
      }),
      Effect.catch((cause) =>
        Deferred.fail(ready, new U4WorkspaceError({ stage: "connection", cause })),
      ),
      Effect.forkScoped,
    );
    yield* handle.exitCode.pipe(
      Effect.andThen(Deferred.fail(ready, new U4WorkspaceError({ stage: "connection" }))),
      Effect.ignore,
      Effect.forkScoped,
    );
    return yield* Deferred.await(ready).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) => new U4WorkspaceError({ stage: "connection", cause })),
    );
  });
  return U4KubernetesConnectionService.of({ pair, forward });
});
export const layer = Layer.effect(U4KubernetesConnectionService, make);
