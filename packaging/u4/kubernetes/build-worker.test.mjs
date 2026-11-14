import { it } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { startWorker } from "./build-worker.mjs";

async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-build-test-"));
  const workspace = NodePath.join(directory, "workspace"),
    home = NodePath.join(directory, "builder"),
    cache = NodePath.join(directory, "cache"),
    socketPath = NodePath.join(directory, "worker.sock");
  for (const path of [workspace, home, cache]) await NodeFSP.mkdir(path);
  const worker = await startWorker({ socketPath, workspaceRoot: workspace, home, cache });
  return {
    workspace,
    home,
    socketPath,
    async [Symbol.asyncDispose]() {
      await worker.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}
function command(socketPath, cwd, argv, onEvent = () => {}) {
  const socket = NodeNet.createConnection(socketPath);
  const events = [];
  let buffer = "";
  const done = new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ cwd, argv })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        events.push(event);
        onEvent(event, socket);
      }
    });
    socket.on("end", () => resolve(events));
  });
  return { socket, done };
}
it("routes cwd/output/status to a separate child without inherited provider credentials", async () => {
  await using f = await fixture();
  const { done } = command(f.socketPath, f.workspace, [
    process.execPath,
    "-e",
    'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,vars:Object.keys(process.env)}));process.stderr.write("failure detail");require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});process.exit(7);',
  ]);
  const events = await done;
  const stdout = events
    .filter((e) => e.type === "stdout")
    .map((e) => Buffer.from(e.data, "base64").toString())
    .join("");
  const state = JSON.parse(stdout);
  NodeAssert.equal(state.cwd, f.workspace);
  NodeAssert.equal(state.home, f.home);
  NodeAssert.deepEqual(
    state.vars.sort(),
    [
      "PATH",
      "JAVA_HOME",
      "LANG",
      "HOME",
      "MAVEN_USER_HOME",
      "npm_config_cache",
      "MAVEN_OPTS",
      "NODE_OPTIONS",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_TERMINAL_PROMPT",
    ]
      .filter((x) => x !== "JAVA_HOME" || process.env.JAVA_HOME !== undefined)
      .sort(),
  );
  NodeAssert.equal(events.at(-1).code, 7);
  NodeAssert.equal(
    events
      .filter((e) => e.type === "stderr")
      .map((e) => Buffer.from(e.data, "base64").toString())
      .join(""),
    "failure detail",
  );
});
it("rejects concurrent builds, cancels the owned process, and rejects paths outside the workspace", async () => {
  await using f = await fixture();
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const running = command(
    f.socketPath,
    f.workspace,
    [process.execPath, "-e", 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    (event) => {
      if (event.type === "stdout") startedResolve();
    },
  );
  await started;
  const busy = await command(f.socketPath, f.workspace, [process.execPath, "-e", "process.exit(0)"])
    .done;
  NodeAssert.deepEqual(busy, [{ type: "error", reason: "busy" }]);
  running.socket.write('{"type":"cancel"}\n');
  NodeAssert.equal((await running.done).at(-1).signal, "SIGTERM");
  const invalid = await command(f.socketPath, "/tmp", [process.execPath, "-e", "process.exit(0)"])
    .done;
  NodeAssert.deepEqual(invalid, [{ type: "error", reason: "invalid" }]);
  const next = await command(f.socketPath, f.workspace, [process.execPath, "-e", "process.exit(0)"])
    .done;
  NodeAssert.equal(next.at(-1).code, 0);
  const missing = await command(f.socketPath, f.workspace, ["u4-no-such-build-command"]).done;
  NodeAssert.equal(missing.at(-1).code, 125);
  NodeAssert.ok(missing.some((e) => e.type === "error" && e.reason === "spawn"));
});
