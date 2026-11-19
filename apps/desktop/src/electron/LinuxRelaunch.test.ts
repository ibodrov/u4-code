// @effect-diagnostics nodeBuiltinImport:off -- Drives the helper with real processes and a FIFO.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";

import * as LinuxRelaunch from "./LinuxRelaunch.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("LinuxRelaunch", () => {
  it.live("starts the target with its arguments only once the old process has exited", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "u4-relaunch-" });
      const order = path.join(dir, "order.log");
      const done = path.join(dir, "done.fifo");
      NodeChildProcess.execFileSync("mkfifo", [done]);

      const oldExited = yield* Deferred.make<void>();
      const oldApp = NodeChildProcess.spawn(
        "bash",
        ["-c", 'read -r _; echo old-exited >> "$1"', "old-app", order],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      oldApp.once("exit", () => Deferred.doneUnsafe(oldExited, Effect.void));
      const pid = oldApp.pid;
      if (pid === undefined) return yield* Effect.die("old app did not start");

      const started = LinuxRelaunch.relaunchAfterExit({
        pid,
        execPath: "bash",
        args: ["-c", 'echo "target $1" >> "$2"; echo done > "$3"', "target", "--flag", order, done],
      });
      assert.isTrue(started);

      // The old app is still running here; the target must not have started yet.
      assert.isFalse(yield* fileSystem.exists(order));
      oldApp.stdin?.end();
      yield* Deferred.await(oldExited);
      yield* fileSystem.readFileString(done);

      const lines = (yield* fileSystem.readFileString(order)).trim().split("\n");
      assert.deepEqual(lines, ["old-exited", "target --flag"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
