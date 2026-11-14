import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ResourceName = Schema.String.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/));
const DigestImage = Schema.String.check(
  Schema.isPattern(/^registry\.ibodrov\.ca\/homelab\/u4-[a-z0-9-]+@sha256:[a-f0-9]{64}$/),
);
export const U4ClusterProfile = Schema.Struct({
  id: ResourceName,
  label: TrimmedNonEmptyString,
  context: TrimmedNonEmptyString,
  namespace: ResourceName,
  runtimeImage: DigestImage,
  builderImage: DigestImage,
  storageClass: ResourceName,
  storageGiB: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 256 })),
  maxWorkspaces: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
});
export type U4ClusterProfile = typeof U4ClusterProfile.Type;

export const U4WorkspaceStatus = Schema.Literals([
  "provisioning",
  "ready",
  "container-restarting",
  "unreachable",
  "lost",
  "stopped",
]);
export const U4KubernetesWorkspace = Schema.Struct({
  id: ResourceName,
  name: ResourceName,
  profileId: ResourceName,
  projectId: ProjectId,
  ownerId: TrimmedNonEmptyString,
  generation: Schema.Int,
  podName: ResourceName,
  podUid: Schema.NullOr(Schema.String),
  pvcName: ResourceName,
  serviceName: ResourceName,
  baseSha: Schema.String,
  snapshotSha256: Schema.String,
  snapshotInstalled: Schema.Boolean,
  sourceRemoteUrl: Schema.optionalKey(Schema.String),
  verifiedAt: Schema.optionalKey(Schema.String),
  bootstrapExpiresAt: Schema.optionalKey(Schema.String),
  forgottenAt: Schema.optionalKey(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  node: Schema.NullOr(Schema.String),
  route: Schema.NullOr(Schema.String),
  status: U4WorkspaceStatus,
  serverRestartReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  builderRestartReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  serverRestarts: Schema.Int,
  builderRestarts: Schema.Int,
  storageGiB: Schema.Int,
  remotePath: Schema.String,
});
export type U4KubernetesWorkspace = typeof U4KubernetesWorkspace.Type;

export const U4WorkspaceLaunchRequest = Schema.Struct({
  profileId: ResourceName,
  projectId: ProjectId,
  name: ResourceName,
});
export type U4WorkspaceLaunchRequest = typeof U4WorkspaceLaunchRequest.Type;
export const U4WorkspaceLifecycleRequest = Schema.Struct({
  id: ResourceName,
  action: Schema.Literals(["refresh", "stop", "restart", "reattach", "forget", "restore"]),
  approveReplacement: Schema.optionalKey(Schema.Boolean),
});
export type U4WorkspaceLifecycleRequest = typeof U4WorkspaceLifecycleRequest.Type;
export const U4WorkspaceConnectRequest = Schema.Struct({
  id: ResourceName,
  transport: Schema.optionalKey(Schema.Literals(["tailnet", "forward", "stop-forward"])),
});
export const U4WorkspaceConnection = Schema.Struct({
  environmentId: Schema.String,
  route: Schema.NullOr(Schema.String),
  // Bootstrap credentials are returned only to an environment-maintenance session.
  pairingCode: Schema.String,
  forwardExpiresAt: Schema.optionalKey(Schema.String),
});
export const U4WorkspaceExportRequest = Schema.Struct({
  id: ResourceName,
  branch: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,120}$/)),
  expectedHead: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  title: TrimmedNonEmptyString,
  body: Schema.String.check(Schema.isMaxLength(20000)),
});
export type U4WorkspaceExportRequest = typeof U4WorkspaceExportRequest.Type;
export const U4WorkspaceExport = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  bundleSha256: Schema.String,
  bundlePath: Schema.String,
  stagingPath: Schema.String,
  draftPath: Schema.String,
});
export type U4WorkspaceExport = typeof U4WorkspaceExport.Type;
export const U4WorkspaceList = Schema.Struct({
  profiles: Schema.Array(U4ClusterProfile),
  workspaces: Schema.Array(U4KubernetesWorkspace),
});
export type U4WorkspaceList = typeof U4WorkspaceList.Type;
export class U4WorkspaceError extends Schema.TaggedError<U4WorkspaceError>()("U4WorkspaceError", {
  stage: Schema.Literals([
    "configuration",
    "ownership",
    "snapshot",
    "cluster",
    "replacement",
    "transfer",
    "storage",
    "connection",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.stage) {
      case "configuration":
        return "Configure a valid Kubernetes profile on the managing environment.";
      case "ownership":
        return "Workspace ownership or instance identity does not match. No resource was changed.";
      case "snapshot":
        return "Select a clean registered Git checkout without submodules, LFS, or tracked environment files.";
      case "replacement":
        return "Explicit replacement approval and a fenced previous instance are required.";
      case "transfer":
        return "Workspace transfer verification failed. The source checkout was not changed.";
      case "storage":
        return "The workspace ledger or retained storage could not be accessed.";
      case "connection":
        return "The workspace is not ready for pairing. Refresh its status and retry.";
      case "cluster":
        return "Kubernetes operation failed. Check the selected context, namespace, capacity and events.";
    }
  }
}
