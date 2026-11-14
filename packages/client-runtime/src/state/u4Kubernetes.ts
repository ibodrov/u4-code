import { WS_METHODS, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import { connectionRoutes, connectionRouteId } from "../connection/routes.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createU4KubernetesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const retireBootstrap = Effect.fn("u4.workspaces.retireBootstrap")(function* (id: string | null) {
    if (!id) return;
    const connections = yield* EnvironmentRegistry;
    const environmentId = EnvironmentId.make(id);
    const entry = (yield* SubscriptionRef.get(connections.entries)).get(environmentId);
    if (!entry) return;
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (profile?._tag === "BearerConnectionProfile" && profile.bootstrapExpiresAt !== undefined)
        yield* connections
          .removeRoute(environmentId, connectionRouteId(route.target))
          .pipe(Effect.ignore);
    }
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "u4:workspaces:list",
    tag: WS_METHODS.u4WorkspaceList,
  });
  return {
    list,
    launch: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:launch",
      tag: WS_METHODS.u4WorkspaceLaunch,
      // A failed launch can still leave a saved record, so the list refreshes either way.
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    lifecycle: createEnvironmentRpcCommand<
      R | EnvironmentRegistry,
      E,
      typeof WS_METHODS.u4WorkspaceLifecycle
    >(runtime, {
      label: "u4:workspaces:lifecycle",
      tag: WS_METHODS.u4WorkspaceLifecycle,
      onSuccess: ({ environmentId, input }, registry, workspace) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))).pipe(
          Effect.andThen(
            ["stop", "forget", "restart"].includes(input.action)
              ? retireBootstrap(workspace.environmentId)
              : Effect.void,
          ),
        ),
    }),
    connect: createEnvironmentRpcCommand<
      R | EnvironmentRegistry,
      E,
      typeof WS_METHODS.u4WorkspaceConnect
    >(runtime, {
      label: "u4:workspaces:connect",
      tag: WS_METHODS.u4WorkspaceConnect,
      onSuccess: ({ environmentId }, registry, result) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))).pipe(
          Effect.andThen(retireBootstrap(result.environmentId)),
        ),
    }),
    export: createEnvironmentRpcCommand(runtime, {
      label: "u4:workspaces:export",
      tag: WS_METHODS.u4WorkspaceExport,
    }),
  };
}
