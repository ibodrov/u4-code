// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Wall-clock cadence is measured here; this child receives only the owned synthetic path.
import * as NodeTimers from "node:timers";
import * as NodeSqlite from "node:sqlite";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const [mode, filename, scratch] = process.argv.slice(2);
if (
  !filename ||
  !scratch ||
  !NodeFS.realpathSync(filename).startsWith(NodeFS.realpathSync(scratch) + NodePath.sep)
)
  throw new Error("Peer path outside owned scratch");
const db = new NodeSqlite.DatabaseSync(NodePath.resolve(filename));
db.exec("PRAGMA busy_timeout=5000");
let timer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
const writes: Array<{ milliseconds: number; busy: boolean }> = [];
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  if (timer) NodeTimers.clearTimeout(timer);
  if (mode === "reader") db.exec("COMMIT");
  db.close();
  process.stdin.destroy();
  process.stdout.write(JSON.stringify({ type: "done", pid: process.pid, writes }) + "\n");
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", stop);
process.stdin.on("end", stop);
if (mode === "reader") {
  db.exec("BEGIN");
  db.prepare("SELECT COUNT(*) FROM orchestration_v2_projection_threads").get();
  timer = NodeTimers.setTimeout(stop, 10000);
} else if (mode === "writer") {
  const write = () => {
    if (stopped) return;
    const start = NodePerfHooks.performance.now();
    let busy = false;
    try {
      db.prepare("INSERT INTO bench_external_writer(value) VALUES (?)").run(writes.length);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("locked")) busy = true;
      else throw cause;
    }
    writes.push({ milliseconds: NodePerfHooks.performance.now() - start, busy });
    timer = NodeTimers.setTimeout(write, 50);
  };
  timer = NodeTimers.setTimeout(write, 50);
} else throw new Error("Unknown benchmark peer mode");
process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\n");
