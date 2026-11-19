// @effect-diagnostics nodeBuiltinImport:off -- Drives the helper with real processes and FIFOs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as LinuxRelaunch from "./LinuxRelaunch.ts";

// Opening a FIFO read-write never blocks and releases any process blocked opening its other end.
const releaseFifo = (fifo: string) =>
  Effect.sync(() => {
    try {
      NodeFS.closeSync(
        NodeFS.openSync(fifo, NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK),
      );
    } catch {}
  });

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("LinuxRelaunch", () => {
  it.live("execs the target with its arguments only after its parent has exited", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "u4-relaunch-" });
      const events = path.join(dir, "events.fifo");
      const gate = path.join(dir, "gate.fifo");
      NodeChildProcess.execFileSync("mkfifo", [events, gate]);
      yield* Effect.addFinalizer(() => releaseFifo(events).pipe(Effect.andThen(releaseFifo(gate))));
      // The helper's wait loop sleeps between checks; this sleep reports that and blocks on the gate.
      yield* fileSystem.writeFileString(
        path.join(dir, "sleep"),
        '#!/bin/sh\necho waiting > "$EVENTS"\nread -r _ < "$GATE"\n',
      );
      yield* fileSystem.chmod(path.join(dir, "sleep"), 0o755);

      const hostEnvironment = yield* HostProcess.Environment;
      const oldExited = yield* Deferred.make<void>();
      const oldApp = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(
            "bash",
            [
              "-c",
              'bash -p -c "$1" relaunch "$$" bash -c \'echo "target $1" > "$EVENTS"\' target --flag & read -r _',
              "old-app",
              LinuxRelaunch.RELAUNCH_AFTER_EXIT,
            ],
            {
              env: {
                ...hostEnvironment,
                PATH: `${dir}:${hostEnvironment.PATH}`,
                EVENTS: events,
                GATE: gate,
              },
              stdio: ["pipe", "ignore", "ignore"],
            },
          ),
        ),
        (child) => Effect.sync(() => child.kill("SIGKILL")),
      );
      oldApp.once("exit", () => Deferred.doneUnsafe(oldExited, Effect.void));

      assert.strictEqual(yield* fileSystem.readFileString(events), "waiting\n");
      oldApp.stdin?.end();
      yield* Deferred.await(oldExited);
      yield* fileSystem.writeFileString(gate, "go\n");
      assert.strictEqual(yield* fileSystem.readFileString(events), "target --flag\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
