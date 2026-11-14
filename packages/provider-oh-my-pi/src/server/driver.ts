import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { ServerProvider } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { ompUsageReader } from "./usage.ts";
import { checkOmpStatus, initialOmpSnapshot, discoverOmp } from "./status.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

const decodeSettings = Schema.decodeSync(OmpSettings);
const DRIVER = ProviderDriverKind.make("oh-my-pi");
const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "oh-my-pi does not provide application text generation",
    }),
  );
const textGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
  generateReviewGuide: () => unsupported("generateReviewGuide"),
  generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
};
export type OmpDriverEnv = OmpAdapterV2DriverEnv | ProviderHost.ProviderHost | Path.Path;
export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: DRIVER,
  metadata: { displayName: "oh-my-pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  usage: ompUsageReader,
  create: Effect.fn("OmpDriver.create")(function* (input) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const environment = yield* mergeProviderInstanceEnvironment(input.environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId: input.instanceId,
    });
    const config = { ...input.config, enabled: input.enabled };
    let inventory:
      | Pick<ServerProvider, "models" | "auth" | "status" | "slashCommands" | "skills">
      | undefined;
    const stamp = (draft: ServerProviderDraft) => ({
      ...draft,
      driver: DRIVER,
      instanceId: input.instanceId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const orchestrationAdapter = yield* OmpAdapterV2Driver.create(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Could not create oh-my-pi adapter",
            cause,
          }),
      ),
    );
    const snapshot = yield* makeManagedServerProvider({
      getSettings: Effect.succeed(config),
      streamSettings: Stream.empty,
      haveSettingsChanged: () => false,
      initialSnapshot: () => initialOmpSnapshot(config).pipe(Effect.map(stamp)),
      checkProvider: checkOmpStatus(config, environment).pipe(
        Effect.map((draft) =>
          stamp(
            inventory && config.enabled && draft.installed ? { ...draft, ...inventory } : draft,
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: "@oh-my-pi/pi-coding-agent",
          }),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Could not create oh-my-pi snapshot",
            cause,
          }),
      ),
    );
    return {
      instanceId: input.instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      refreshModels: Effect.fn("OmpDriver.refreshModels")(function* () {
        if (!config.enabled) return;
        inventory = yield* discoverOmp(config, environment, host.paths.cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId: input.instanceId,
                detail: "Could not refresh oh-my-pi models",
                cause,
              }),
          ),
        );
        yield* snapshot.refresh.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId: input.instanceId,
                detail: "Could not refresh oh-my-pi snapshot",
                cause,
              }),
          ),
        );
      }),
      snapshot,
      orchestrationAdapter,
      textGeneration,
      snapshotForCwd: Effect.fn("OmpDriver.snapshotForCwd")(function* (cwd) {
        const current = yield* snapshot.getSnapshot;
        if (!config.enabled) return current;
        const discovery = yield* discoverOmp(config, environment, cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId: input.instanceId,
                detail: "Could not discover oh-my-pi workspace",
                cause,
              }),
          ),
        );
        return {
          ...current,
          ...discovery,
          workspaceModels: discovery.models,
          slashCommandsPending: false,
        };
      }),
    };
  }),
};
