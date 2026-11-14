import { it, vi } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import { startWorker } from "./build-worker.mjs";

const io = vi.hoisted(() => ({ gate: null, spawned: null }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    spawn: (...args) => {
      const child = original.spawn(...args);
      io.spawned?.(child);
      return child;
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    realpath: async (path, ...args) => {
      if (io.gate && path === io.gate.path) {
        const gate = io.gate;
        io.gate = null;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return original.realpath(path, ...args);
    },
  };
});
async function fixture() {
  io.gate = null;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-build-test-"));
  const workspace = NodePath.join(directory, "workspace"),
    home = NodePath.join(directory, "builder"),
    cache = NodePath.join(directory, "cache"),
    buildRoot = NodePath.join(directory, "build"),
    socketPath = NodePath.join(directory, "worker.sock");
  for (const path of [workspace, home, cache, buildRoot]) await NodeFSP.mkdir(path);
  const git = (...args) =>
    NodeUtil.promisify(NodeChildProcess.execFile)("git", args, { cwd: workspace });
  await git("init", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(workspace, "source.txt"), "original\n");
  await NodeFSP.writeFile(NodePath.join(workspace, ".gitignore"), "target/\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const supervisorPath = NodePath.join(directory, "supervisor");
  await NodeUtil.promisify(NodeChildProcess.execFile)("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    supervisorPath,
    NodePath.join(import.meta.dirname, "build-supervisor.c"),
  ]);
  const worker = await startWorker({
    socketPath,
    workspaceRoot: workspace,
    buildRoot,
    home,
    cache,
    supervisorPath,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await worker.close();
    }
  };
  return {
    workspace,
    buildRoot,
    home,
    socketPath,
    close,
    async [Symbol.asyncDispose]() {
      await close();
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
  NodeAssert.ok(state.cwd.startsWith(f.buildRoot + NodePath.sep));
  NodeAssert.notEqual(state.cwd, f.workspace);
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
  NodeAssert.ok(missing.some((e) => e.type === "error" && e.reason === "supervision"));
});

it("keeps its reservation when a second run line arrives during filesystem preparation", async () => {
  await using f = await fixture();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  io.gate = { path: f.workspace, entered, release };
  const invalid = Promise.withResolvers();
  const first = command(
    f.socketPath,
    f.workspace,
    [process.execPath, "-e", "process.exit(0)"],
    (event) => {
      if (event.type === "error") invalid.resolve();
    },
  );
  try {
    await entered.promise;
    first.socket.write(
      JSON.stringify({ cwd: f.workspace, argv: [process.execPath, "-e", "process.exit(0)"] }) +
        "\n",
    );
    await invalid.promise;
    const second = await command(f.socketPath, f.workspace, [
      process.execPath,
      "-e",
      "process.exit(0)",
    ]).done;
    NodeAssert.deepEqual(second, [{ type: "error", reason: "busy" }]);
  } finally {
    release.resolve();
    io.gate = null;
    await first.done;
  }
});
it("builds a private copy, preserves outputs until source changes, and leaves source metadata unchanged", async () => {
  await using f = await fixture();
  const source = NodePath.join(f.workspace, "source.txt");
  const config = await NodeFSP.readFile(NodePath.join(f.workspace, ".git/config"), "utf8");
  const edit = await command(f.socketPath, f.workspace, [
    process.execPath,
    "-e",
    'require("fs").writeFileSync("source.txt","builder edit\\n");require("fs").writeFileSync("generated.txt","build output");require("child_process").execFileSync("git",["config","core.fsmonitor","echo marker"]);',
  ]).done;
  NodeAssert.equal(edit.at(-1).code, 0);
  NodeAssert.equal(await NodeFSP.readFile(source, "utf8"), "original\n");
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(f.workspace, ".git/config"), "utf8"),
    config,
  );
  const read = await command(f.socketPath, f.workspace, [
    process.execPath,
    "-e",
    'process.stdout.write(require("fs").readFileSync("source.txt"));',
  ]).done;
  NodeAssert.ok(
    read.some(
      (e) => e.type === "stdout" && Buffer.from(e.data, "base64").toString() === "original\n",
    ),
  );
  await NodeFSP.writeFile(NodePath.join(f.workspace, "untracked.txt"), "real untracked");
  await NodeFSP.symlink("source.txt", NodePath.join(f.workspace, "source-link"));
  for (const mutation of [
    'fs.unlinkSync("source.txt")',
    'fs.unlinkSync("source.txt");fs.symlinkSync("untracked.txt","source.txt")',
    'fs.unlinkSync("source.txt");fs.mkdirSync("source.txt")',
    'fs.writeFileSync("untracked.txt","forged");fs.unlinkSync("source-link");fs.writeFileSync("source-link","fake link")',
  ]) {
    const edit = await command(f.socketPath, f.workspace, [
      process.execPath,
      "-e",
      `const fs=require('fs');${mutation};fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/output','preserve ignored');fs.writeFileSync('../'+require('path').basename(process.cwd())+'.json','forged manifest')`,
    ]).done;
    NodeAssert.equal(edit.at(-1).code, 0);
    const checked = await command(f.socketPath, f.workspace, [
      process.execPath,
      "-e",
      `const f=require('fs');require('assert').equal(f.readFileSync('source.txt','utf8'),'original\\n');require('assert').equal(f.readFileSync('untracked.txt','utf8'),'real untracked');require('assert').equal(f.readlinkSync('source-link'),'source.txt');require('assert').equal(f.readFileSync('target/output','utf8'),'preserve ignored');`,
    ]).done;
    NodeAssert.equal(checked.at(-1).code, 0);
  }
  await NodeFSP.rm(NodePath.join(f.workspace, "untracked.txt"));
  const deleted = await command(f.socketPath, f.workspace, [
    process.execPath,
    "-e",
    "require('assert').equal(require('fs').existsSync('untracked.txt'),false)",
  ]).done;
  NodeAssert.equal(deleted.at(-1).code, 0);
  await NodeFSP.writeFile(source, "updated source\n");
  const changed = await command(f.socketPath, f.workspace, [
    process.execPath,
    "-e",
    'process.stdout.write(require("fs").readFileSync("source.txt"));',
  ]).done;
  NodeAssert.ok(
    changed.some(
      (e) => e.type === "stdout" && Buffer.from(e.data, "base64").toString() === "updated source\n",
    ),
  );
  const future = NodePath.join(f.workspace, "future");
  await NodeUtil.promisify(NodeChildProcess.execFile)("git", [
    "-C",
    f.workspace,
    "worktree",
    "add",
    "-b",
    "future",
    future,
  ]);
  const pointer = await NodeFSP.readFile(NodePath.join(future, ".git"), "utf8");
  const copied = await command(f.socketPath, future, [
    process.execPath,
    "-e",
    'process.stdout.write(String(require("fs").statSync(".git").isDirectory()))',
  ]).done;
  NodeAssert.equal(copied.at(-1).code, 0);
  NodeAssert.ok(
    copied.some((e) => e.type === "stdout" && Buffer.from(e.data, "base64").toString() === "true"),
  );
  NodeAssert.equal(await NodeFSP.readFile(NodePath.join(future, ".git"), "utf8"), pointer);
});

it("reaps owned detached descendants before freeing its slot, including cancellation and shutdown", async () => {
  await using f = await fixture();
  const exited = Promise.withResolvers();
  const pids = [];
  io.spawned = (child) => child.once("exit", () => exited.resolve());
  const descendant =
    'console.log(JSON.stringify({descendant:process.pid}));process.send("ready");setInterval(()=>{},1000)';
  const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit','ipc']});c.once('message',()=>process.exit(7))`;
  const first = command(f.socketPath, f.workspace, [process.execPath, "-e", script], (event) => {
    if (event.type === "stdout")
      pids.push(JSON.parse(Buffer.from(event.data, "base64").toString()).descendant);
  });
  try {
    await exited.promise;
    for (const pid of pids) NodeAssert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    NodeAssert.equal((await first.done).at(-1).code, 7);
    const next = await command(f.socketPath, f.workspace, [
      process.execPath,
      "-e",
      "process.exit(0)",
    ]).done;
    NodeAssert.equal(next.at(-1).code, 0);
    io.spawned = null;
    for (const mode of ["cancel", "shutdown"]) {
      const ready = Promise.withResolvers();
      const held = command(
        f.socketPath,
        f.workspace,
        [process.execPath, "-e", script.replace("process.exit(7)", "setInterval(()=>{},1000)")],
        (event) => {
          if (event.type === "stdout") {
            pids.push(JSON.parse(Buffer.from(event.data, "base64").toString()).descendant);
            ready.resolve();
          }
        },
      );
      await ready.promise;
      if (mode === "cancel") held.socket.write('{"type":"cancel"}\n');
      else await f.close();
      await held.done;
      for (const pid of pids) NodeAssert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      if (mode === "cancel")
        NodeAssert.equal(
          (
            await command(f.socketPath, f.workspace, [process.execPath, "-e", "process.exit(0)"])
              .done
          ).at(-1).code,
          0,
        );
    }
  } finally {
    io.spawned = null;
    // These PIDs came from this fixture's child, including on the failing implementation.
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await first.done;
  }
});

it("reports bounded preparation stages without source contents", async () => {
  await using f = await fixture();
  const missing = await command(f.socketPath, NodePath.join(f.workspace, "missing"), ["true"]).done;
  NodeAssert.deepEqual(missing, [{ type: "error", reason: "missing-worktree" }]);
  const huge = NodePath.join(f.workspace, "oversized");
  const handle = await NodeFSP.open(huge, "w");
  await handle.truncate(512 * 1024 * 1024 + 1);
  await handle.close();
  const capped = await command(f.socketPath, f.workspace, ["true"]).done;
  NodeAssert.deepEqual(capped, [{ type: "error", reason: "snapshot-limit" }]);
  await NodeFSP.rm(huge);
  await NodeUtil.promisify(NodeChildProcess.execFile)("mkfifo", [
    NodePath.join(f.workspace, "unsupported"),
  ]);
  const unsupported = await command(f.socketPath, f.workspace, ["true"]).done;
  NodeAssert.deepEqual(unsupported, [{ type: "error", reason: "unsupported-entry" }]);
});
