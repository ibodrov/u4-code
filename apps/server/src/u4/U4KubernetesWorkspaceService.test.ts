import { it, expect } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
function setup() {
  let workspaces: ReadonlyArray<U4KubernetesWorkspace> = [initial];
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
  const mutations: string[][] = [];
  const kubectl = Layer.succeed(
    U4KubectlClient.U4KubectlClient,
    U4KubectlClient.U4KubectlClient.of({
      run: (_, args) =>
        Effect.suspend(() => {
          if (!online) return Effect.fail(new U4WorkspaceError({ stage: "cluster" }));
          if (args[0] === "get") {
            if (args[1] === "pods")
              return Effect.succeed(JSON.stringify({ items: pod ? [pod] : [] }));
            if (args[1] === "node")
              return Effect.succeed(
                JSON.stringify({
                  status: { conditions: [{ type: "Ready", status: nodeReady ? "True" : "False" }] },
                }),
              );
            return Effect.succeed(
              JSON.stringify({
                metadata: { name: args[2], uid: "resource", labels: workspaceLabels(initial) },
                status: { loadBalancer: { ingress: [{ hostname: "u4-test.example.ts.net" }] } },
              }),
            );
          }
          if (args[0] === "exec") return Effect.succeed("environment\n");
          mutations.push([...args]);
          if (args[0] === "delete" && args[1] === "pod") pod = null;
          if (args[0] === "create") {
            const current = workspaces[0]!;
            pod = {
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
          install: () =>
            Effect.sync(() => {
              installed++;
            }),
        }),
        Layer.mock(U4KubernetesConnectionService.U4KubernetesConnectionService)({}),
      ),
    ),
  );
  return {
    layer,
    mutations,
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
      expect(fixture.mutations.filter((args) => args[0] === "delete")).toEqual([
        ["delete", "pod", initial.podName, "--wait=true", "--timeout=120s"],
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
  expect(builder!.volumeMounts.map((m) => m.mountPath)).toEqual([
    "/workspace",
    "/cache",
    "/run/u4-build",
    "/tmp",
  ]);
  expect(resources.pvc.metadata).not.toHaveProperty("ownerReferences");
});
