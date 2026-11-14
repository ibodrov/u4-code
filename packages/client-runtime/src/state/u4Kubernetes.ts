import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createU4KubernetesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "u4:workspaces:list",
    tag: WS_METHODS.u4WorkspaceList,
  });
  return {
    list,
    launch: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:launch",
      tag: WS_METHODS.u4WorkspaceLaunch,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    lifecycle: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:lifecycle",
      tag: WS_METHODS.u4WorkspaceLifecycle,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:connect",
      tag: WS_METHODS.u4WorkspaceConnect,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    export: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:export",
      tag: WS_METHODS.u4WorkspaceExport,
    }),
  };
}
