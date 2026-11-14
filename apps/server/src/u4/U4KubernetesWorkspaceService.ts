import {
  U4WorkspaceError,
  type U4KubernetesWorkspace,
  type U4WorkspaceLaunchRequest,
  type U4WorkspaceLifecycleRequest,
  type U4WorkspaceExportRequest,
  type U4WorkspaceExport,
  type U4ClusterProfile,
  type U4WorkspaceList,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as U4KubectlClient from "./U4KubectlClient.ts";
import * as U4WorkspaceRepository from "./U4WorkspaceRepository.ts";
import * as U4WorkspaceTransferService from "./U4WorkspaceTransferService.ts";
import * as U4KubernetesConnectionService from "./U4KubernetesConnectionService.ts";
import { workspaceLabels, workspaceResources } from "./workspaceResources.ts";

export class U4KubernetesWorkspaceService extends Context.Service<
  U4KubernetesWorkspaceService,
  {
    readonly list: Effect.Effect<U4WorkspaceList, U4WorkspaceError>;
    readonly launch: (
      input: U4WorkspaceLaunchRequest,
    ) => Effect.Effect<U4KubernetesWorkspace, U4WorkspaceError>;
    readonly lifecycle: (
      input: U4WorkspaceLifecycleRequest,
    ) => Effect.Effect<U4KubernetesWorkspace, U4WorkspaceError>;
    readonly connect: (input: {
      readonly id: string;
    }) => Effect.Effect<
      { environmentId: string; route: string | null; pairingCode: string },
      U4WorkspaceError
    >;
    readonly export: (
      input: U4WorkspaceExportRequest,
    ) => Effect.Effect<U4WorkspaceExport, U4WorkspaceError>;
  }
>()("t3/u4/U4KubernetesWorkspaceService") {}

export const make = Effect.gen(function* () {
  const repository = yield* U4WorkspaceRepository.U4WorkspaceRepository;
  const kubectl = yield* U4KubectlClient.U4KubectlClient;
  const transfer = yield* U4WorkspaceTransferService.U4WorkspaceTransferService;
  const connections = yield* U4KubernetesConnectionService.U4KubernetesConnectionService;
  const random = yield* SecureRandom.SecureRandom;
  const mutex = yield* Semaphore.make(1);
  const profileFor = Effect.fn("U4KubernetesWorkspaceService.profile")(function* (id: string) {
    const profile = (yield* repository.profiles).find((p) => p.id === id);
    if (!profile) return yield* new U4WorkspaceError({ stage: "configuration" });
    return profile;
  });
  const owned = Effect.fn("U4KubernetesWorkspaceService.owned")(function* (id: string) {
    const ledger = yield* repository.read;
    const workspace = ledger.workspaces.find((w) => w.id === id);
    if (!workspace || workspace.ownerId !== ledger.ownerId)
      return yield* new U4WorkspaceError({ stage: "ownership" });
    return { ledger, workspace, profile: yield* profileFor(workspace.profileId) };
  });
  const save = Effect.fn("U4KubernetesWorkspaceService.save")(function* (
    workspace: U4KubernetesWorkspace,
  ) {
    const ledger = yield* repository.read;
    yield* repository.save({
      ...ledger,
      workspaces: [...ledger.workspaces.filter((w) => w.id !== workspace.id), workspace],
    });
    return workspace;
  });
  const pods = Effect.fn("U4KubernetesWorkspaceService.pods")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const result = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.PodList,
      yield* kubectl.run(profile, [
        "get",
        "pods",
        "-l",
        `u4.ibodrov.ca/workspace=${workspace.id}`,
        "-o",
        "json",
      ]),
    );
    for (const pod of result.items) {
      if (
        Object.entries(workspaceLabels(workspace)).some(
          ([key, value]) => pod.metadata.labels?.[key] !== value,
        ) ||
        pod.metadata.name !== workspace.podName ||
        (workspace.podUid !== null && workspace.podUid !== pod.metadata.uid)
      )
        return yield* new U4WorkspaceError({ stage: "ownership" });
    }
    return result.items;
  });
  const assertResource = Effect.fn("U4KubernetesWorkspaceService.assertResource")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
    kind: string,
    name: string,
  ) {
    const resource = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.Resource,
      yield* kubectl.run(profile, ["get", kind, name, "-o", "json"]),
    );
    if (
      Object.entries(workspaceLabels(workspace)).some(
        ([key, value]) => resource.metadata.labels?.[key] !== value,
      )
    )
      return yield* new U4WorkspaceError({ stage: "ownership" });
  });
  const reconcile = Effect.fn("U4KubernetesWorkspaceService.reconcile")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const found = yield* pods(profile, workspace);
    const pod = found[0];
    if (!pod)
      return yield* save({
        ...workspace,
        status: workspace.status === "stopped" ? "stopped" : "lost",
        route: null,
      });
    const server = pod.status.containerStatuses?.find((c) => c.name === "server");
    const builder = pod.status.containerStatuses?.find((c) => c.name === "builder");
    const service = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.Service,
      yield* kubectl.run(profile, ["get", "service", workspace.serviceName, "-o", "json"]),
    );
    if (
      Object.entries(workspaceLabels(workspace)).some(
        ([key, value]) => service.metadata.labels?.[key] !== value,
      )
    )
      return yield* new U4WorkspaceError({ stage: "ownership" });
    const hostname = service.status?.loadBalancer?.ingress?.find((i) =>
      i.hostname?.endsWith(".ts.net"),
    )?.hostname;
    let environmentId = workspace.environmentId;
    if (server?.ready) {
      const identity = (yield* kubectl.run(profile, [
        "exec",
        workspace.podName,
        "-c",
        "server",
        "--",
        "cat",
        "/state/u4/userdata/environment-id",
      ])).trim();
      if (!identity || (environmentId !== null && identity !== environmentId))
        return yield* new U4WorkspaceError({ stage: "ownership" });
      environmentId = identity;
    }
    return yield* save({
      ...workspace,
      podUid: pod.metadata.uid,
      node: pod.spec.nodeName ?? null,
      environmentId,
      route: hostname && /^[a-zA-Z0-9.-]+$/.test(hostname) ? `http://${hostname}:4773` : null,
      status:
        pod.metadata.deletionTimestamp || pod.status.phase === "Failed"
          ? "lost"
          : server?.ready && builder?.ready
            ? "ready"
            : server?.restartCount || builder?.restartCount
              ? "container-restarting"
              : "provisioning",
      serverRestartReason:
        server?.state?.waiting?.reason ?? server?.lastState?.terminated?.reason ?? null,
      builderRestartReason:
        builder?.state?.waiting?.reason ?? builder?.lastState?.terminated?.reason ?? null,
      serverRestarts: server?.restartCount ?? 0,
      builderRestarts: builder?.restartCount ?? 0,
    });
  });
  const createCompute = Effect.fn("U4KubernetesWorkspaceService.createCompute")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    const resources = workspaceResources(profile, workspace);
    yield* kubectl.run(
      profile,
      ["create", "-f", "-"],
      yield* U4KubectlClient.encodeJson(resources.pod),
    );
    // Selectors advance only after the new Pod is recorded; a failed create never reroutes traffic.
    yield* assertResource(profile, workspace, "service", workspace.serviceName);
    yield* kubectl.run(profile, [
      "patch",
      "service",
      workspace.serviceName,
      "--type=merge",
      "-p",
      yield* U4KubectlClient.encodeJson({ spec: resources.service.spec }),
    ]);
    const current = yield* reconcile(profile, workspace);
    yield* transfer.install(profile, current);
    return yield* reconcile(profile, { ...current, snapshotInstalled: true });
  });
  const launch = Effect.fn("U4KubernetesWorkspaceService.launch")(function* (
    input: U4WorkspaceLaunchRequest,
  ) {
    const profile = yield* profileFor(input.profileId);
    const ledger = yield* repository.read;
    if (ledger.workspaces.some((w) => w.profileId === profile.id && w.name === input.name))
      return yield* new U4WorkspaceError({ stage: "ownership" });
    const all = yield* U4KubectlClient.decodeJson(
      U4KubectlClient.PodList,
      yield* kubectl.run(profile, [
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/part-of=u4-code",
        "-o",
        "json",
      ]),
    );
    if (all.items.length >= profile.maxWorkspaces)
      return yield* new U4WorkspaceError({ stage: "cluster" });
    const id = `ws-${(yield* random.uuidV4()).slice(0, 8)}`;
    const snapshot = yield* transfer.snapshot(input.projectId, id);
    const workspace: U4KubernetesWorkspace = {
      id,
      name: input.name,
      profileId: profile.id,
      projectId: input.projectId,
      ownerId: ledger.ownerId,
      generation: 1,
      podName: `${id}-1`,
      podUid: null,
      pvcName: `${id}-data`,
      serviceName: id,
      baseSha: snapshot.baseSha,
      snapshotSha256: snapshot.snapshotSha256,
      snapshotInstalled: false,
      ...(snapshot.sourceRemoteUrl ? { sourceRemoteUrl: snapshot.sourceRemoteUrl } : {}),
      environmentId: null,
      node: null,
      route: null,
      status: "provisioning",
      serverRestarts: 0,
      builderRestarts: 0,
      storageGiB: profile.storageGiB,
      remotePath: "/workspace/repo",
    };
    yield* save(workspace);
    const resources = workspaceResources(profile, workspace);
    yield* kubectl.run(
      profile,
      ["create", "-f", "-"],
      yield* U4KubectlClient.encodeJson(resources.pvc),
    );
    yield* kubectl.run(
      profile,
      ["create", "-f", "-"],
      yield* U4KubectlClient.encodeJson(resources.service),
    );
    return yield* createCompute(profile, workspace);
  }, mutex.withPermits(1));
  const lifecycle = Effect.fn("U4KubernetesWorkspaceService.lifecycle")(function* (
    input: U4WorkspaceLifecycleRequest,
  ) {
    const { workspace, profile } = yield* owned(input.id);
    if (input.action === "refresh" || input.action === "reattach")
      return yield* Effect.gen(function* () {
        const current = yield* reconcile(profile, workspace);
        if (current.status === "ready" && !current.snapshotInstalled) {
          yield* transfer.install(profile, current);
          return yield* save({ ...current, snapshotInstalled: true });
        }
        return current;
      }).pipe(
        Effect.catchTags({
          U4WorkspaceError: (error) =>
            error.stage === "cluster"
              ? save({ ...workspace, status: "unreachable" })
              : Effect.fail(error),
        }),
      );
    const found = yield* pods(profile, workspace);
    if (input.action === "forget") {
      if (found.length) return yield* new U4WorkspaceError({ stage: "replacement" });
      yield* assertResource(profile, workspace, "service", workspace.serviceName);
      yield* kubectl.run(profile, ["delete", "service", workspace.serviceName, "--wait=true"]);
      const ledger = yield* repository.read;
      yield* repository.save({
        ...ledger,
        workspaces: ledger.workspaces.filter((w) => w.id !== workspace.id),
      });
      return { ...workspace, status: "stopped" as const };
    }
    if (input.action === "stop") {
      if (found.length)
        yield* kubectl.run(profile, [
          "delete",
          "pod",
          workspace.podName,
          "--wait=true",
          "--timeout=120s",
        ]);
      return yield* save({ ...workspace, status: "stopped", route: null });
    }
    if (!input.approveReplacement || found.length)
      return yield* new U4WorkspaceError({ stage: "replacement" });
    if (workspace.node) {
      const node = yield* U4KubectlClient.decodeJson(
        Schema.Struct({
          status: Schema.Struct({
            conditions: Schema.Array(Schema.Struct({ type: Schema.String, status: Schema.String })),
          }),
        }),
        yield* kubectl.run(profile, ["get", "node", workspace.node, "-o", "json"]),
      );
      if (!node.status.conditions.some((c) => c.type === "Ready" && c.status === "True"))
        return yield* new U4WorkspaceError({ stage: "replacement" });
    }
    yield* assertResource(profile, workspace, "pvc", workspace.pvcName);
    const next = yield* save({
      ...workspace,
      generation: workspace.generation + 1,
      podName: `${workspace.id}-${workspace.generation + 1}`,
      podUid: null,
      status: "provisioning",
      route: null,
    });
    return yield* createCompute(profile, next);
  }, mutex.withPermits(1));
  const connect = Effect.fn("U4KubernetesWorkspaceService.connect")(function* (input: {
    readonly id: string;
  }) {
    const { workspace, profile } = yield* owned(input.id);
    const current = yield* reconcile(profile, workspace);
    if (current.status !== "ready") return yield* new U4WorkspaceError({ stage: "connection" });
    return yield* connections.pair(profile, current);
  }, mutex.withPermits(1));
  const exportWorkspace = Effect.fn("U4KubernetesWorkspaceService.export")(function* (
    input: U4WorkspaceExportRequest,
  ) {
    const { workspace, profile } = yield* owned(input.id);
    const current = yield* reconcile(profile, workspace);
    if (current.status !== "ready") return yield* new U4WorkspaceError({ stage: "connection" });
    return yield* transfer.export(profile, current, input);
  }, mutex.withPermits(1));
  return U4KubernetesWorkspaceService.of({
    list: Effect.gen(function* () {
      return {
        profiles: yield* repository.profiles,
        workspaces: (yield* repository.read).workspaces,
      };
    }).pipe(mutex.withPermits(1)),
    launch,
    lifecycle,
    connect,
    export: exportWorkspace,
  });
});
export const layer = Layer.effect(U4KubernetesWorkspaceService, make).pipe(
  Layer.provide(U4WorkspaceTransferService.layer),
  Layer.provide(U4KubernetesConnectionService.layer),
  Layer.provideMerge(U4KubectlClient.layer),
  Layer.provideMerge(U4WorkspaceRepository.layer),
);
