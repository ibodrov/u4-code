import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createT3ImportCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    open: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: open",
      tag: WS_METHODS.u4T3ImportOpen,
    }),
    getSession: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: session",
      tag: WS_METHODS.u4T3ImportGetSession,
    }),
    listThreads: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: threads",
      tag: WS_METHODS.u4T3ImportListThreads,
    }),
    preview: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: preview",
      tag: WS_METHODS.u4T3ImportPreview,
    }),
    previewPage: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: preview page",
      tag: WS_METHODS.u4T3ImportPreviewPage,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: start",
      tag: WS_METHODS.u4T3ImportStart,
    }),
    getJob: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: results",
      tag: WS_METHODS.u4T3ImportGetJob,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: cancel",
      tag: WS_METHODS.u4T3ImportCancel,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "T3 import: close",
      tag: WS_METHODS.u4T3ImportClose,
    }),
  };
}
