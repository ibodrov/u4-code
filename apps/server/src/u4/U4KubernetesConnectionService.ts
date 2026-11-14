import {
  U4WorkspaceError,
  type U4ClusterProfile,
  type U4KubernetesWorkspace,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as U4KubectlClient from "./U4KubectlClient.ts";
import { workspaceLabels } from "./workspaceResources.ts";

export function isLocalBootstrapClient(client: {
  readonly ipAddress?: string | undefined;
  readonly origin?: string | undefined;
}) {
  try {
    return (
      client.ipAddress !== undefined &&
      isLocalLoopbackHost(client.ipAddress) &&
      client.origin !== undefined &&
      isLocalLoopbackHost(new URL(client.origin).hostname)
    );
  } catch {
    return false;
  }
}
export class U4KubernetesConnectionService extends Context.Service<
  U4KubernetesConnectionService,
  {
    readonly pair: (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
      transport?: "tailnet" | "forward",
      localClient?: boolean,
    ) => Effect.Effect<
      {
        environmentId: string;
        route: string | null;
        pairingCode: string;
        forwardExpiresAt?: string;
      },
      U4WorkspaceError
    >;
    readonly stop: (id: string) => Effect.Effect<void>;
    readonly expiresAt: (id: string) => Effect.Effect<string | undefined>;
  }
>()("t3/u4/U4KubernetesConnectionService") {}
const isWorkspaceError = Schema.is(U4WorkspaceError);
const make = Effect.gen(function* () {
  const kubectl = yield* U4KubectlClient.U4KubectlClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerScope = yield* Scope.Scope;
  const leases = new Map<
    string,
    { uid: string; route: string; expiresAt: string; scope: Scope.Closeable }
  >();
  const stop = Effect.fn("U4KubernetesConnectionService.stop")(function* (id: string) {
    const lease = leases.get(id);
    leases.delete(id);
    if (lease) yield* Scope.close(lease.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => Effect.forEach([...leases.keys()], stop, { discard: true }));
  const validate = Effect.fn("U4KubernetesConnectionService.validate")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const pod = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.Pod,
      yield* kubectl.run(profile, ["get", "pod", workspace.podName, "-o", "json"]),
    );
    if (
      !workspace.podUid ||
      pod.metadata.uid !== workspace.podUid ||
      pod.metadata.name !== workspace.podName ||
      pod.metadata.deletionTimestamp ||
      Object.entries(workspaceLabels(workspace)).some(([k, v]) => pod.metadata.labels?.[k] !== v)
    )
      return yield* new U4WorkspaceError({ stage: "ownership" });
  });
  const forward = Effect.fn("U4KubernetesConnectionService.forward")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    yield* validate(profile, workspace).pipe(Effect.onError(() => stop(workspace.id)));
    const existing = leases.get(workspace.id);
    if (existing?.uid === workspace.podUid && existing.route) return existing;
    yield* stop(workspace.id);
    const scope = yield* Scope.fork(ownerScope);
    const ready = yield* Deferred.make<string, U4WorkspaceError>();
    const lease = {
      uid: workspace.podUid!,
      route: "",
      expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 30 })),
      scope,
    };
    leases.set(workspace.id, lease);
    let port = "0";
    const attempt = Effect.gen(function* () {
      yield* validate(profile, workspace);
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "kubectl",
          [
            "--context",
            profile.context,
            "--namespace",
            profile.namespace,
            "port-forward",
            `pod/${workspace.podName}`,
            `${port}:4773`,
            "--address",
            "127.0.0.1",
          ],
          { stdin: "ignore" },
        ),
      );
      yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const found = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(line)?.[1];
          if (!found) return Effect.void;
          port = found;
          lease.route = `http://127.0.0.1:${port}`;
          return Deferred.succeed(ready, lease.route).pipe(Effect.asVoid);
        }),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* handle.exitCode;
      return yield* new U4WorkspaceError({ stage: "connection" });
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isWorkspaceError(cause) ? cause : new U4WorkspaceError({ stage: "connection", cause }),
      ),
    );
    yield* attempt.pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced("1 second"),
        while: (error) => error.stage !== "ownership",
      }),
      Effect.catch((error) => Deferred.fail(ready, error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (leases.get(workspace.id) === lease) leases.delete(workspace.id);
        }).pipe(
          Effect.andThen(
            Scope.close(scope, Exit.void).pipe(Effect.forkIn(ownerScope), Effect.asVoid),
          ),
        ),
      ),
      Effect.forkIn(scope),
    );
    yield* Effect.sleep("30 minutes").pipe(
      Effect.andThen(
        Effect.suspend(() =>
          leases.get(workspace.id) === lease ? stop(workspace.id) : Effect.void,
        ).pipe(Effect.forkIn(ownerScope)),
      ),
      Effect.forkIn(scope),
    );
    yield* Deferred.await(ready).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) => new U4WorkspaceError({ stage: "connection", cause })),
      Effect.onError(() => stop(workspace.id)),
    );
    return lease;
  });
  const pair = Effect.fn("U4KubernetesConnectionService.pair")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
    transport: "tailnet" | "forward" = "tailnet",
    localClient = false,
  ) {
    if (transport === "forward" && !localClient)
      return yield* new U4WorkspaceError({ stage: "connection" });
    if (transport === "tailnet" && !workspace.route)
      return yield* new U4WorkspaceError({ stage: "connection" });
    const lease = transport === "forward" ? yield* forward(profile, workspace) : undefined;
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
    return {
      environmentId,
      route: lease?.route ?? workspace.route,
      pairingCode,
      ...(lease ? { forwardExpiresAt: lease.expiresAt } : {}),
    };
  });
  return U4KubernetesConnectionService.of({
    pair,
    stop,
    expiresAt: Effect.fn("U4KubernetesConnectionService.expiresAt")((id: string) =>
      Effect.sync(() => leases.get(id)?.expiresAt),
    ),
  });
});
export const layer = Layer.effect(U4KubernetesConnectionService, make);
