import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { selectCliRuntimeExternalDependencies } from "../../../scripts/lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
} from "../../../scripts/build-desktop-artifact.ts";
import manifest from "../package.json" with { type: "json" };
import root from "../../../package.json" with { type: "json" };

class U4RuntimeInstallError extends Schema.TaggedError<U4RuntimeInstallError>()(
  "U4RuntimeInstallError",
  { exitCode: Schema.Int },
) {
  override get message(): string {
    return "Runtime dependency installation failed.";
  }
}
const Workspace = Schema.Struct({
  catalog: Schema.Record(Schema.String, Schema.String),
  overrides: Schema.Record(Schema.String, Schema.String),
  patchedDependencies: Schema.Record(Schema.String, Schema.String),
  allowBuilds: Schema.Record(Schema.String, Schema.Boolean),
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const destination = path.resolve(process.argv[2] ?? "/tmp/u4-k8s-image");
  const runtime = path.join(destination, "runtime");
  yield* fs.makeDirectory(runtime, { recursive: true });
  const workspace = yield* Schema.decodeEffect(fromYaml(Workspace))(
    yield* fs.readFileString("pnpm-workspace.yaml"),
  );
  const resolved = resolveCatalogDependencies(
    manifest.dependencies,
    workspace.catalog,
    "apps/server",
  );
  const dependencies = {
    ...selectCliRuntimeExternalDependencies(resolved),
    ...resolveFffNativeDependencies("linux", "x64", resolved["@ff-labs/fff-node"]!),
  };
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies,
    dependencies,
  );
  yield* fs.writeFileString(
    path.join(runtime, "package.json"),
    yield* encodeJson({
      name: "u4-runtime",
      version: manifest.version,
      private: true,
      packageManager: root.packageManager,
      dependencies,
    }),
  );
  yield* fs.writeFileString(
    path.join(runtime, "pnpm-workspace.yaml"),
    yield* Schema.encodeEffect(fromYaml(Schema.Unknown))({
      ...createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: workspace.allowBuilds,
        patchedDependencies,
        overrides: resolveCatalogDependencies(
          workspace.overrides,
          workspace.catalog,
          "apps/server",
        ),
      }),
      nodeLinker: "hoisted",
    }),
  );
  yield* fs.copy("patches", path.join(runtime, "patches"), { overwrite: true });
  const code = yield* spawner.exitCode(
    ChildProcess.make("pnpm", ["install", "--prod"], {
      cwd: runtime,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (code !== 0) return yield* new U4RuntimeInstallError({ exitCode: code });
  yield* fs.copyFile("apps/server/dist-exe/t3-linux-x64", path.join(runtime, "t3"));
  yield* fs.copy("apps/server/dist/client", path.join(runtime, "client"), { overwrite: true });
  yield* fs.makeDirectory(path.join(runtime, "resource-monitor/linux-x64"), { recursive: true });
  yield* fs.copyFile(
    "native/resource-monitor/target/release/t3-resource-monitor",
    path.join(runtime, "resource-monitor/linux-x64/t3-resource-monitor"),
  );
  for (const file of [
    "Dockerfile",
    "build-worker.mjs",
    "build-snapshot.mjs",
    "prepare-volume.mjs",
    "workspace.mjs",
    "entrypoint.mjs",
  ])
    yield* fs.copyFile(`packaging/u4/kubernetes/${file}`, path.join(destination, file));
  yield* Effect.log(`Staged U4 Kubernetes image at ${destination}`);
});
program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
