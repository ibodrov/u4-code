// @effect-diagnostics nodeBuiltinImport:off - Spawns a detached helper synchronously, just before the app exits.
import * as NodeChildProcess from "node:child_process";

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
const CLOSE_INHERITED_FDS =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done';

export const CLOSE_INHERITED_FDS_THEN_EXEC = `${CLOSE_INHERITED_FDS}; exec "$@"`;

// The helper is reparented the moment the app exits, zombie or not, and the app's
// single-instance lock is released by then. Fields after the last ")" are state, then ppid.
const WAIT_FOR_PARENT_EXIT = [
  "parent=$1; shift",
  "while :; do",
  "  read -r stat < /proc/self/stat",
  '  read -r -a fields <<< "${stat##*) }"',
  '  [ "${fields[1]}" = "$parent" ] || break',
  "  sleep 0.05",
  "done",
].join("\n");

/** bash -c script: `$1` is the exiting parent's pid, the rest is the command to exec. */
export const RELAUNCH_AFTER_EXIT = `${CLOSE_INHERITED_FDS}\n${WAIT_FOR_PARENT_EXIT}\nexec "$@"`;

/**
 * Starts `execPath args` once this process exits. Electron's own relauncher runs with
 * no_new_privs, so an AppImage it starts cannot mount itself through setuid fusermount.
 * Returns false when the helper process could not be spawned.
 */
export const relaunchAfterExit = (input: {
  readonly execPath: string;
  readonly args: ReadonlyArray<string>;
}): boolean => {
  const helper = NodeChildProcess.spawn(
    "bash",
    [
      "-p",
      "-c",
      RELAUNCH_AFTER_EXIT,
      "relaunch",
      String(process.pid),
      input.execPath,
      ...input.args,
    ],
    { detached: true, stdio: "ignore" },
  );
  // A failed spawn leaves pid undefined; its later error event must not crash the exiting app.
  helper.on("error", () => {});
  helper.unref();
  return helper.pid !== undefined;
};
