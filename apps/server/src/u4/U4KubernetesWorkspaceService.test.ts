import { it, expect } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProjectId,
  U4WorkspaceError,
  type U4KubernetesWorkspace,
  type U4ClusterProfile,
} from "@t3tools/contracts";
import * as U4KubernetesWorkspaceService from "./U4KubernetesWorkspaceService.ts";
import * as U4WorkspaceRepository from "./U4WorkspaceRepository.ts";
import * as U4KubectlClient from "./U4KubectlClient.ts";
import * as U4WorkspaceTransferService from "./U4WorkspaceTransferService.ts";
import * as U4KubernetesConnectionService from "./U4KubernetesConnectionService.ts";
import { workspaceLabels, workspaceResources } from "./workspaceResources.ts";

const profile: U4ClusterProfile = {
  id: "local",
  label: "Local k3s",
  context: "test-context",
  namespace: "test-u4",
  runtimeImage: `registry.ibodrov.ca/homelab/u4-runtime@sha256:${"a".repeat(64)}`,
  builderImage: `registry.ibodrov.ca/homelab/u4-builder@sha256:${"b".repeat(64)}`,
  storageClass: "longhorn-retain",
  storageGiB: 32,
  maxWorkspaces: 2,
};
const initial: U4KubernetesWorkspace = {
  id: "ws-test",
  name: "concord",
  profileId: "local",
  projectId: ProjectId.make("project"),
  ownerId: "manager",
  generation: 1,
  podName: "ws-test-1",
  podUid: "uid-1",
  pvcName: "ws-test-data",
  serviceName: "ws-test",
  baseSha: "a".repeat(40),
  snapshotSha256: "b".repeat(64),
  snapshotInstalled: true,
  environmentId: "environment",
  node: "node",
  route: null,
  status: "ready",
  serverRestarts: 0,
  builderRestarts: 0,
  storageGiB: 32,
  remotePath: "/workspace/repo",
};
function setup(snapshotInstalled = true) {
  let workspaces: ReadonlyArray<U4KubernetesWorkspace> = [{ ...initial, snapshotInstalled }];
  let pod: typeof U4KubectlClient.Pod.Type | null = {
    metadata: { name: initial.podName, uid: "uid-1", labels: workspaceLabels(initial) },
    spec: { nodeName: "node" },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "server", ready: true, restartCount: 0 },
        { name: "builder", ready: true, restartCount: 0 },
      ],
    },
  };
  let online = true,
    nodeReady = true,
    installed = 0;
  let selector: Record<string, string> = {
    ...workspaceLabels(initial),
    "u4.ibodrov.ca/generation": "1",
  };
  let failPatch = false;
  const otherPods = new Map<string, typeof U4KubectlClient.Pod.Type>();
  const serviceSelectors = new Map<string, Record<string, string>>();
  const deletedServices = new Set<string>();
  let installBarrier: Effect.Effect<void> | undefined;
  const mutations: string[][] = [];
  const kubectl = Layer.succeed(
    U4KubectlClient.U4KubectlClient,
    U4KubectlClient.U4KubectlClient.of({
      download: () => Effect.void,
      run: (_, args, stdin) =>
        Effect.suspend(() => {
          if (!online) return Effect.fail(new U4WorkspaceError({ stage: "cluster" }));
          if (args[0] === "get") {
            if (args[1] === "pods")
              return Effect.succeed(
                JSON.stringify({
                  items: [...(pod ? [pod] : []), ...otherPods.values()].filter(
                    (p) =>
                      args[3] === "app.kubernetes.io/part-of=u4-code" ||
                      args[3] ===
                        `u4.ibodrov.ca/workspace=${p.metadata.labels?.["u4.ibodrov.ca/workspace"]}`,
                  ),
                }),
              );
            if (args[1] === "node")
              return Effect.succeed(
                JSON.stringify({
                  status: { conditions: [{ type: "Ready", status: nodeReady ? "True" : "False" }] },
                }),
              );
            if (args[1] === "service" && deletedServices.has(args[2]!)) return Effect.succeed("");
            const record =
              workspaces.find((w) => w.serviceName === args[2] || w.pvcName === args[2]) ?? initial;
            return Effect.succeed(
              JSON.stringify({
                metadata: { name: args[2], uid: "resource", labels: workspaceLabels(record) },
                spec: {
                  selector: record.id === initial.id ? selector : serviceSelectors.get(record.id),
                },
                status: { loadBalancer: { ingress: [{ hostname: "u4-test.example.ts.net" }] } },
              }),
            );
          }
          if (args[0] === "exec") return Effect.succeed("environment\n");
          mutations.push([...args]);
          if (args[0] === "patch") {
            if (failPatch) return Effect.fail(new U4WorkspaceError({ stage: "cluster" }));
            const next = JSON.parse(args[args.indexOf("-p") + 1]!).spec.selector;
            if (args[2] === initial.serviceName) selector = next;
            else serviceSelectors.set(workspaces.find((w) => w.serviceName === args[2])!.id, next);
          }
          if (args[0] === "delete" && args[1] === "pod") {
            if (pod?.metadata.name === args[2]) pod = null;
            else otherPods.delete(args[2]!);
          }
          if (args[0] === "delete" && args[1] === "service") deletedServices.add(args[2]!);
          if (args[0] === "create") {
            const resource = JSON.parse(stdin!);
            if (resource.kind === "Service") {
              deletedServices.delete(resource.metadata.name);
              serviceSelectors.set(
                resource.metadata.labels["u4.ibodrov.ca/workspace"],
                resource.spec.selector,
              );
              return Effect.succeed("");
            }
            if (resource.kind !== "Pod") return Effect.succeed("");
            const current = workspaces.find((w) => w.podName === resource.metadata.name)!;
            const created = {
              metadata: { name: current.podName, uid: "uid-2", labels: workspaceLabels(current) },
              spec: { nodeName: "node" },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "server", ready: true, restartCount: 0 },
                  { name: "builder", ready: true, restartCount: 0 },
                ],
              },
            };
            if (current.id === initial.id) pod = created;
            else otherPods.set(current.podName, created);
          }
          return Effect.succeed("");
        }),
    }),
  );
  const repository = Layer.succeed(
    U4WorkspaceRepository.U4WorkspaceRepository,
    U4WorkspaceRepository.U4WorkspaceRepository.of({
      directory: "/tmp/test",
      profiles: Effect.succeed([profile]),
      read: Effect.sync(() => ({ ownerId: "manager", workspaces })),
      save: (ledger) =>
        Effect.sync(() => {
          workspaces = ledger.workspaces;
        }),
    }),
  );
  const layer = Layer.effect(
    U4KubernetesWorkspaceService.U4KubernetesWorkspaceService,
    U4KubernetesWorkspaceService.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        kubectl,
        repository,
        NodeCrypto.layer,
        Layer.mock(U4WorkspaceTransferService.U4WorkspaceTransferService)({
          snapshot: () =>
            Effect.succeed({
              baseSha: initial.baseSha,
              snapshotSha256: initial.snapshotSha256,
              bundlePath: "/tmp/test.bundle",
              sourceRemoteUrl: "https://example.invalid/repo.git",
            }),
          install: () =>
            Effect.sync(() => {
              installed++;
            }).pipe(Effect.andThen(Effect.suspend(() => installBarrier ?? Effect.void))),
        }),
        Layer.mock(U4KubernetesConnectionService.U4KubernetesConnectionService)({
          stop: () => Effect.void,
          expiresAt: () => Effect.undefined,
        }),
      ),
    ),
  );
  return {
    layer,
    mutations,
    set installBarrier(value: Effect.Effect<void>) {
      installBarrier = value;
    },
    addRetained() {
      workspaces = [
        ...workspaces,
        {
          ...initial,
          id: "ws-other",
          podName: "ws-other-1",
          pvcName: "ws-other-data",
          serviceName: "ws-other",
          podUid: null,
          status: "stopped",
        },
      ];
    },
    set failPatch(value: boolean) {
      failPatch = value;
    },

    get selector() {
      return selector;
    },
    get installed() {
      return installed;
    },
    set online(value: boolean) {
      online = value;
    },
    set nodeReady(value: boolean) {
      nodeReady = value;
    },
    removePod() {
      pod = null;
    },
    replaceUid() {
      pod = { ...pod!, metadata: { ...pod!.metadata, uid: "foreign" } };
    },
  };
}
it.effect(
  "requires explicit replacement approval, fences the old instance, and retains storage across stop/restart",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
      expect(
        (yield* Effect.flip(
          service.lifecycle({ id: initial.id, action: "restart", approveReplacement: true }),
        )).stage,
      ).toBe("replacement");
      const stopped = yield* service.lifecycle({ id: initial.id, action: "stop" });
      expect(stopped.status).toBe("stopped");
      expect(
        (yield* Effect.flip(service.lifecycle({ id: initial.id, action: "restart" }))).stage,
      ).toBe("replacement");
      fixture.nodeReady = false;
      expect(
        (yield* Effect.flip(
          service.lifecycle({ id: initial.id, action: "restart", approveReplacement: true }),
        )).stage,
      ).toBe("replacement");
      fixture.nodeReady = true;
      const next = yield* service.lifecycle({
        id: initial.id,
        action: "restart",
        approveReplacement: true,
      });
      expect(next).toMatchObject({
        generation: 2,
        podUid: "uid-2",
        environmentId: "environment",
        pvcName: initial.pvcName,
        status: "ready",
      });
      expect(fixture.installed).toBe(1);
      yield* service.lifecycle({ id: initial.id, action: "stop" });
      const archived = yield* service.lifecycle({ id: initial.id, action: "forget" });
      expect(archived.forgottenAt).toBeDefined();
      expect((yield* service.list).workspaces).toHaveLength(1);
      const restored = yield* service.lifecycle({ id: initial.id, action: "restore" });
      expect(restored.forgottenAt).toBeUndefined();
      expect(restored.pvcName).toBe(initial.pvcName);
      expect(fixture.mutations.filter((args) => args[0] === "delete")).toEqual([
        ["delete", "pod", initial.podName, "--wait=true", "--timeout=120s"],
        ["delete", "pod", "ws-test-2", "--wait=true", "--timeout=120s"],
        ["delete", "service", initial.serviceName, "--wait=true"],
      ]);
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect(
  "network failure and reattachment never create compute, and foreign Pod UIDs are rejected",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
      fixture.online = false;
      expect((yield* service.lifecycle({ id: initial.id, action: "refresh" })).status).toBe(
        "unreachable",
      );
      fixture.online = true;
      expect((yield* service.lifecycle({ id: initial.id, action: "reattach" })).status).toBe(
        "ready",
      );
      fixture.replaceUid();
      expect(
        (yield* Effect.flip(service.lifecycle({ id: initial.id, action: "stop" }))).stage,
      ).toBe("ownership");
      expect(fixture.mutations).toEqual([]);
    }).pipe(Effect.provide(fixture.layer));
  },
);
it("keeps the provider home out of the builder and separates memory budgets on retained storage", () => {
  const resources = workspaceResources(profile, initial);
  const [server, builder] = resources.pod.spec.containers;
  expect(resources.pod.spec).toMatchObject({
    restartPolicy: "Always",
    automountServiceAccountToken: false,
    nodeSelector: { "kubernetes.io/arch": "amd64" },
  });
  expect(server!.resources.limits.memory).toBe("3Gi");
  expect(builder!.resources.limits.memory).toBe("9Gi");
  expect(builder!.securityContext).toMatchObject({ runAsUser: 1001, readOnlyRootFilesystem: true });
  expect(builder!.volumeMounts.find((m) => m.mountPath === "/workspace")).toMatchObject({
    readOnly: true,
  });
  expect(resources.pod.spec.securityContext).toMatchObject({
    fsGroupChangePolicy: "OnRootMismatch",
  });
  expect(builder!.volumeMounts.map((m) => m.mountPath)).toEqual([
    "/workspace",
    "/cache",
    "/run/u4-build",
    "/build",
    "/tmp",
  ]);
  expect(resources.pvc.metadata).not.toHaveProperty("ownerReferences");
});

it.effect("installs an incomplete snapshot exactly once on refresh", () => {
  const f = setup(false);
  return Effect.gen(function* () {
    const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
    expect(
      (yield* service.lifecycle({ id: initial.id, action: "refresh" })).snapshotInstalled,
    ).toBe(true);
    expect(f.installed).toBe(1);
    yield* service.lifecycle({ id: initial.id, action: "refresh" });
    expect(f.installed).toBe(1);
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "caps replacement compute after A/B, stop A, launch C; retained PVCs do not occupy compute slots",
  () => {
    const f = setup();
    return Effect.gen(function* () {
      const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
      const b = yield* service.launch({
        profileId: profile.id,
        projectId: initial.projectId,
        name: "b",
      });
      yield* service.lifecycle({ id: initial.id, action: "stop" });
      const c = yield* service.launch({
        profileId: profile.id,
        projectId: initial.projectId,
        name: "c",
      });
      expect(b.status).toBe("ready");
      expect(c.status).toBe("ready");
      expect(
        (yield* Effect.flip(
          service.lifecycle({ id: initial.id, action: "restart", approveReplacement: true }),
        )).stage,
      ).toBe("cluster");
      expect((yield* service.list).workspaces).toHaveLength(3);
      expect(f.mutations.filter((args) => args[0] === "create")).toHaveLength(6);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "repairs an owned stale Service selector after create succeeds and selector patch fails",
  () => {
    const f = setup();
    return Effect.gen(function* () {
      const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
      yield* service.lifecycle({ id: initial.id, action: "stop" });
      f.failPatch = true;
      yield* Effect.flip(
        service.lifecycle({ id: initial.id, action: "restart", approveReplacement: true }),
      );
      const unreachable = yield* service.lifecycle({ id: initial.id, action: "refresh" });
      expect(unreachable.status).not.toBe("ready");
      expect(unreachable.route).toBeNull();
      f.failPatch = false;
      const recovered = yield* service.lifecycle({ id: initial.id, action: "refresh" });
      expect(recovered.status).toBe("ready");
      expect(f.selector["u4.ibodrov.ca/generation"]).toBe("2");
      expect(f.mutations.filter((args) => args[0] === "create")).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a slow workspace install does not block listing or another workspace's stop", () => {
  const f = setup(false);
  f.addRetained();
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    f.installBarrier = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const service = yield* U4KubernetesWorkspaceService.U4KubernetesWorkspaceService;
    const installing = yield* service
      .lifecycle({ id: initial.id, action: "refresh" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect((yield* service.list).workspaces).toHaveLength(2);
    expect((yield* service.lifecycle({ id: "ws-other", action: "stop" })).status).toBe("stopped");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(installing);
    expect((yield* service.list).workspaces).toHaveLength(2);
  }).pipe(Effect.provide(f.layer));
});
