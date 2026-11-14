import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  buildServerProvider,
  spawnAndCollect,
  parseCliVersionResult,
  providerProbeEnvironment,
  providerModelsFromSettings,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { OmpSettings } from "../settings.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
import {
  OmpRpcError,
  makeOmpRpcConnection,
  ompRecordField as field,
  ompRecordString as string,
} from "./rpc.ts";
import { parseOmpDiscoveredCommands, withOmpBuiltinSlashCommands } from "./commands.ts";

const PRESENTATION = {
  displayName: "oh-my-pi",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
} as const;
export const EMPTY_OMP_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "oh-my-pi default",
  isCustom: false,
  capabilities: EMPTY_OMP_CAPABILITIES,
};

export function ompModelCapabilities(model: unknown) {
  const efforts = field(field(model, "thinking"), "efforts");
  const levels =
    field(model, "reasoning") === true && Array.isArray(efforts)
      ? ["off", ...efforts.filter((level): level is string => typeof level === "string")]
      : [];
  return createModelCapabilities({
    optionDescriptors: levels.length
      ? [
          {
            id: "thinking",
            label: "Thinking",
            role: "reasoning",
            type: "select",
            options: levels.map((id) => ({ id, label: id === "off" ? "Off" : id })),
          },
        ]
      : [],
  });
}

export function normalizeOmpModels(data: unknown): ServerProviderModel[] {
  const models = field(data, "models");
  if (!Array.isArray(models)) throw new Error("Invalid oh-my-pi model inventory");
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const provider = string(model, "provider");
    const id = string(model, "id");
    if (!provider || !id) throw new Error("Invalid oh-my-pi model identity");
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: string(model, "name") ?? slug,
        subProvider: provider,
        isCustom: false,
        capabilities: ompModelCapabilities(model),
      },
    ];
  });
}

export const initialOmpSnapshot = Effect.fn("OmpStatus.initial")(function* (config: OmpSettings) {
  return {
    ...buildServerProvider({
      presentation: PRESENTATION,
      enabled: config.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: providerModelsFromSettings(
        [DEFAULT_MODEL],
        config.customModels,
        EMPTY_OMP_CAPABILITIES,
      ),
      probe: { installed: false, version: null, status: "ready", auth: { status: "unknown" } },
    }),
    supportsTextGeneration: false,
  };
});

export const checkOmpStatus = Effect.fn("OmpStatus.check")(function* (
  config: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const initial = yield* initialOmpSnapshot(config);
  if (!config.enabled) return initial;
  const binary = config.binaryPath || "omp";
  const command = yield* resolveSpawnCommand(binary, ["--version"], { env: environment }).pipe(
    Effect.option,
  );
  if (command._tag === "None")
    return { ...initial, status: "error" as const, message: "oh-my-pi executable was not found" };
  const output = yield* spawnAndCollect(
    binary,
    ChildProcess.make(command.value.command, command.value.args, {
      env: providerProbeEnvironment(environment),
      extendEnv: false,
      shell: command.value.shell,
    }),
  ).pipe(Effect.scoped, Effect.timeoutOption("10 seconds"), Effect.option);
  if (output._tag === "None" || output.value._tag === "None")
    return { ...initial, status: "error" as const, message: "oh-my-pi version check failed" };
  const version = parseCliVersionResult(output.value.value);
  return {
    ...initial,
    installed: true,
    version,
    status: "ready" as const,
    auth: { status: "unknown" as const },
  };
});

export const discoverOmp = Effect.fn("OmpStatus.discover")(function* (
  config: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const args = resolveOmpLaunchArgs(config.launchArgs);
  if (!args.ok)
    return yield* new OmpRpcError({ operation: "launch_arguments", detail: args.message });
  const launch = buildOmpRpcLaunch({ launchArgs: args.args, environment, ephemeral: true });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const rpc = yield* makeOmpRpcConnection({
        command: config.binaryPath || "omp",
        args: launch.args,
        env: launch.env,
        cwd,
      });
      yield* Stream.fromQueue(rpc.events).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      const data = yield* rpc.request({ type: "get_available_models" });
      const models = yield* Effect.try({
        try: () => normalizeOmpModels(data),
        catch: (cause) => new OmpRpcError({ operation: "model_inventory", cause }),
      });
      const state = yield* rpc.request({ type: "get_state" });
      const inherited = {
        ...DEFAULT_MODEL,
        capabilities: ompModelCapabilities(field(state, "model")),
      };
      const commands = parseOmpDiscoveredCommands(
        yield* rpc.request({ type: "get_available_commands" }),
      );
      return {
        models: providerModelsFromSettings(
          [inherited, ...models],
          config.customModels,
          EMPTY_OMP_CAPABILITIES,
        ),
        ...commands,
        slashCommands: withOmpBuiltinSlashCommands(commands.slashCommands),
        auth: { status: models.length ? ("authenticated" as const) : ("unauthenticated" as const) },
        status: models.length ? ("ready" as const) : ("warning" as const),
      };
    }),
  );
});
