// @effect-diagnostics nodeBuiltinImport:off - Spawns a detached helper synchronously, just before the app exits.
import * as NodeChildProcess from "node:child_process";

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
const CLOSE_INHERITED_FDS =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done';

export const CLOSE_INHERITED_FDS_THEN_EXEC = `${CLOSE_INHERITED_FDS}; exec "$@"`;

// A zombie still answers kill -0, but it has already released the single-instance lock.
const WAIT_FOR_EXIT =
  'pid=$1; shift; while kill -0 "$pid" 2>/dev/null; do case $(cat "/proc/$pid/stat" 2>/dev/null) in *") Z "*) break ;; esac; sleep 0.05; done';

const RELAUNCH_AFTER_EXIT = `${CLOSE_INHERITED_FDS}; ${WAIT_FOR_EXIT}; exec "$@"`;

/**
 * Starts `execPath args` once process `pid` exits. Electron's own relauncher runs with
 * no_new_privs, so an AppImage it starts cannot mount itself through setuid fusermount.
 * Returns false when the helper could not be started.
 */
export const relaunchAfterExit = (input: {
  readonly pid: number;
  readonly execPath: string;
  readonly args: ReadonlyArray<string>;
}): boolean => {
  const helper = NodeChildProcess.spawn(
    "bash",
    ["-p", "-c", RELAUNCH_AFTER_EXIT, "relaunch", String(input.pid), input.execPath, ...input.args],
    { detached: true, stdio: "ignore" },
  );
  // A spawn failure leaves pid undefined; its later error event must not crash the exiting app.
  helper.on("error", () => {});
  helper.unref();
  return helper.pid !== undefined;
};
