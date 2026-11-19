import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import { findWindowsShim } from "./update.ts";
import * as BootService from "../cloud/bootService.ts";
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  findOwnedLauncher,
  findRecordedLaunchers,
  spawnWindowsRemoval,
  uninstallCommand,
} from "./uninstall.ts";

afterEach(() => vi.restoreAllMocks());

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("u4 uninstall command", (it) => {
  it.effect("removes U4 while preserving official T3 launchers, runtime, and service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "u4-uninstall-cli-test-" });
      const baseDir = path.join(root, ".u4");
      const officialHome = path.join(root, ".t3");
      const executable = path.join(baseDir, "runtime/versions/1.0.0/t3");
      const officialExecutable = path.join(officialHome, "runtime/versions/1.0.0/t3");
      const launcher = path.join(root, "bin/u4");
      const officialLauncher = path.join(root, "bin/t3");
      const foreignLauncher = path.join(root, "bin/u4-foreign");
      const userdata = path.join(baseDir, "userdata/settings.json");
      for (const [file, contents] of [
        [executable, "U4 runtime"],
        [officialExecutable, "official T3 runtime"],
        [userdata, "U4 settings"],
      ] as const) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, contents);
      }
      yield* fs.makeDirectory(path.dirname(launcher));
      yield* fs.symlink(executable, launcher);
      yield* fs.symlink(officialExecutable, officialLauncher);
      yield* fs.symlink(officialExecutable, foreignLauncher);
      yield* fs.writeFileString(
        path.join(baseDir, "runtime/launchers"),
        [launcher, officialLauncher, foreignLauncher].join("\n"),
      );
      const uninstalls: Array<true> = [];
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed({
              supported: true,
              installed: true,
              current: true,
              installedBaseDir: officialHome,
              unitPath: "/home/me/.config/systemd/user/t3code.service",
              logPath: "/home/me/.t3/userdata/logs/boot-service.log",
            }),
            withStopped: (operation) => operation,
            restart: Effect.die("unexpected restart"),
            install: () => Effect.die("unexpected install"),
            uninstall: Effect.sync(() => {
              uninstalls.push(true);
              return true;
            }),
          }),
        ),
      );

      const output = yield* Command.runWith(uninstallCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        "--yes",
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      assert.deepStrictEqual(uninstalls, []);
      assert.include(output, `--base-dir '${officialHome}'`);
      assert.isFalse(yield* fs.exists(launcher));
      assert.isFalse(yield* fs.exists(path.join(baseDir, "runtime")));
      assert.equal(yield* fs.readFileString(userdata), "U4 settings");
      assert.equal(yield* fs.readLink(officialLauncher), officialExecutable);
      assert.equal(yield* fs.readLink(foreignLauncher), officialExecutable);
      assert.equal(yield* fs.readFileString(officialExecutable), "official T3 runtime");
    }),
  );
});

it.layer(NodeServices.layer)("u4 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // macOS spells the temp folder /var but resolves it to /private/var.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "u4-uninstall-" })
        .pipe(Effect.flatMap(fs.realPath));
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/u4");
      const theirs = path.join(root, "other/bin/u4");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
      // A script launcher execs by absolute path, so argv0 names the executable.
      const scriptDir = path.join(root, "script-bin");
      const script = path.join(scriptDir, "u4");
      yield* fs.makeDirectory(scriptDir);
      yield* fs.writeFileString(script, posixLauncherScript(exe), { mode: 0o755 });
      assert.equal(
        yield* findOwnedLauncher({ launchedAs: exe, versionsDir }).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: scriptDir }),
        ),
        script,
      );
      const editedScript = path.join(scriptDir, "t3-edited");
      yield* fs.writeFileString(editedScript, `${posixLauncherScript(exe)}# mine\n`);

      // On Windows, only the shim exactly as written is ours; a user's wrapper stays.
      const shimDir = path.join(root, "win-bin");
      const shim = path.join(shimDir, "u4.cmd");
      const officialShim = path.join(shimDir, "t3.cmd");
      const officialContents = `@echo off\r\n"${otherExe}" %*`;
      yield* fs.makeDirectory(shimDir);
      yield* fs.writeFileString(officialShim, officialContents);
      const windowsOwner = (contents: string) =>
        fs
          .writeFileString(shim, contents)
          .pipe(
            Effect.andThen(findOwnedLauncher({ launchedAs: exe, versionsDir })),
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(HostProcess.Environment, { PATH: shimDir }),
          );
      assert.equal(yield* windowsOwner(`@echo off\r\n"${exe}" %*`), shim);
      assert.equal(
        yield* findWindowsShim(exe).pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_INSTALL_BIN_DIR: shimDir,
            PATH: "",
          }),
        ),
        shim,
      );
      assert.isUndefined(yield* windowsOwner(`@echo off\r\nset FOO=1\r\n"${exe}" %*`));
      assert.isUndefined(yield* windowsOwner(officialContents));
      assert.equal(yield* fs.readFileString(officialShim), officialContents);
      yield* fs.remove(shim);
      yield* fs.writeFileString(officialShim, `@echo off\r\n"${exe}" %*`);
      assert.equal(yield* windowsOwner(officialContents), officialShim);
      yield* fs.writeFileString(officialShim, officialContents);

      // npx can run another version than the installed one, so uninstall also reads the
      // recorded launchers: through a symlinked home, and dangling after a prune.
      const throughAlias = path.join(root, "bin/u4-alias");
      const pruned = path.join(root, "bin/u4-pruned");
      yield* fs.symlink(root, path.join(root, "alias"));
      yield* fs.symlink(path.join(root, "alias/runtime/versions/1.0.0/t3"), throughAlias);
      yield* fs.symlink(path.join(versionsDir, "0.9.0/t3"), pruned);
      // Another program inside a version is not a launcher.
      const sibling = path.join(root, "bin/u4-sibling");
      yield* fs.symlink(path.join(versionsDir, "1.0.0/node"), sibling);
      yield* fs.writeFileString(
        path.join(root, "runtime/launchers"),
        [
          ours,
          theirs,
          copy,
          throughAlias,
          pruned,
          sibling,
          script,
          editedScript,
          path.join(root, "missing"),
        ].join("\n") + "\n",
      );
      for (const dir of [versionsDir, path.join(root, "alias/runtime/versions")]) {
        assert.deepStrictEqual(yield* findRecordedLaunchers(dir), [
          ours,
          throughAlias,
          pruned,
          script,
        ]);
      }

      // On Windows only an unedited u4.cmd is ours; a hand-edited wrapper belongs to the user.
      const cmd = path.join(root, "bin/u4.cmd");
      const edited = path.join(root, "bin/edited.cmd");
      yield* fs.writeFileString(cmd, `@echo off\r\n"${exe}" %*`);
      yield* fs.writeFileString(edited, `@echo off\r\nset "U4CODE_HOME=D:\\other"\r\n"${exe}" %*`);
      yield* fs.writeFileString(path.join(root, "runtime/launchers"), `${cmd}\r\n${edited}\r\n`);
      assert.deepStrictEqual(
        yield* findRecordedLaunchers(versionsDir).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
        [cmd],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "u4 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "u4-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(
        yield* Config.String("ComSpec").pipe(Config.withDefault("cmd.exe")),
        runtimeDir,
      );
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
