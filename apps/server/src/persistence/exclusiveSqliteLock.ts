// @effect-diagnostics nodeBuiltinImport:off
// A never-unlinked SQLite transaction releases ownership even after process death.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

export function openExclusiveSqliteLock(lockPath: string, busyTimeoutMs: number, mode = 0o644) {
  let before = NodeFS.statSync(lockPath, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) {
    NodeFS.closeSync(NodeFS.openSync(lockPath, "a", mode));
    before = NodeFS.statSync(lockPath, { bigint: true });
  }
  const db = new NodeSqlite.DatabaseSync(lockPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN EXCLUSIVE;`);
    const identity = NodeFS.statSync(lockPath, { bigint: true });
    return {
      db,
      identity,
      replacedDuringAcquire: before.dev !== identity.dev || before.ino !== identity.ino,
    };
  } catch (cause) {
    db.close();
    throw cause;
  }
}
