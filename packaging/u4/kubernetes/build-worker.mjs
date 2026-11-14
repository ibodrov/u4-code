import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import { prepareSnapshot } from "./build-snapshot.mjs";
import * as NodeURL from "node:url";

const within = (root, path) => {
  const rel = NodePath.relative(root, path);
  return rel === "" || (rel.split(NodePath.sep)[0] !== ".." && !NodePath.isAbsolute(rel));
};

export async function startWorker({ socketPath, workspaceRoot, buildRoot, home, cache }) {
  const root = await NodeFSP.realpath(workspaceRoot);
  let active = null;
  const sockets = new Set();
  const pending = new Set();
  const children = new Set();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    const preparation = new AbortController();
    let started = false;
    let child = null;
    let cancelled = false;
    let spawnFailed = false;
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    let killTimer;
    const send = (data) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(data)}\n`);
    };
    const cancel = () => {
      cancelled = true;
      preparation.abort();
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000);
      killTimer.unref();
    };
    socket.on("close", () => {
      sockets.delete(socket);
      cancel();
    });
    socket.on("error", cancel);
    const receive = async (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 65536) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const request = JSON.parse(line);
          if (request.type === "cancel") {
            cancel();
            continue;
          }
          if (started) {
            send({ type: "error", reason: "invalid" });
            cancel();
            socket.end();
            return;
          }
          started = true;
          if (active) {
            send({ type: "error", reason: "busy" });
            socket.end();
            return;
          }
          active = socket;
          if (
            !Array.isArray(request.argv) ||
            request.argv.length === 0 ||
            request.argv.length > 256 ||
            request.argv.some((x) => typeof x !== "string" || x.includes("\0")) ||
            typeof request.cwd !== "string"
          )
            throw new Error("invalid command");
          const sourceCwd = await NodeFSP.realpath(NodePath.resolve(request.cwd));
          if (!within(root, sourceCwd)) throw new Error("cwd outside workspace");
          const cwd = await prepareSnapshot(root, sourceCwd, buildRoot, preparation.signal);
          if (socket.destroyed || cancelled) {
            if (active === socket) active = null;
            return;
          }
          child = NodeChildProcess.spawn(request.argv[0], request.argv.slice(1), {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              JAVA_HOME: process.env.JAVA_HOME,
              LANG: "C.UTF-8",
              HOME: home,
              MAVEN_USER_HOME: `${cache}/maven`,
              npm_config_cache: `${cache}/npm`,
              MAVEN_OPTS: `-Xmx5g -XX:ActiveProcessorCount=3 -Dmaven.repo.local=${cache}/maven/repository -Duser.home=${home}`,
              NODE_OPTIONS: "--max-old-space-size=6144",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
          });
          const ended = new Promise((resolve) => child.once("close", resolve));
          children.add(ended);
          ended.then(() => children.delete(ended));
          send({ type: "started", pid: child.pid, cwd });
          for (const [type, stream] of [
            ["stdout", child.stdout],
            ["stderr", child.stderr],
          ]) {
            stream.on("data", (data) => {
              if (!socket.write(`${JSON.stringify({ type, data: data.toString("base64") })}\n`))
                stream.pause();
            });
            socket.on("drain", () => stream.resume());
          }
          child.on("error", () => {
            spawnFailed = true;
            send({ type: "error", reason: "spawn" });
          });
          child.on("exit", () => {
            clearTimeout(killTimer);
            // Descendants must not retain the build slot after their command exits.
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          });
          child.on("close", (code, signal) => {
            if (active === socket) active = null;
            send({ type: "exit", code: spawnFailed ? 125 : code, signal });
            socket.end();
          });
        } catch {
          if (active === socket && !child) active = null;
          send({ type: "error", reason: "invalid" });
          socket.end();
        }
      }
    };
    socket.on("data", (chunk) => {
      const work = receive(chunk).catch(() => socket.destroy());
      pending.add(work);
      work.finally(() => pending.delete(work));
    });
  });
  await NodeFSP.rm(socketPath, { force: true });
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, res);
  });
  await NodeFSP.chmod(socketPath, 0o660);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled(pending);
      await Promise.allSettled(children);
      await new Promise((res) => server.close(res));
      await NodeFSP.rm(socketPath, { force: true });
    },
  };
}

async function runClient() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  if (!argv.length) throw new Error("usage: u4-build -- command [args]");
  const socket = NodeNet.createConnection(
    process.env.U4_BUILD_SOCKET ?? "/run/u4-build/worker.sock",
  );
  let buffer = "",
    finished = false;
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const cancel = () => {
    socket.write('{"type":"cancel"}\n');
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  socket.on("connect", () =>
    socket.write(`${JSON.stringify({ type: "run", cwd: process.cwd(), argv })}\n`),
  );
  socket.on("data", (data) => {
    buffer += decoder.write(data);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (event.type === "stdout" || event.type === "stderr")
        process[event.type].write(Buffer.from(event.data, "base64"));
      if (event.type === "error") {
        process.stderr.write(`u4-build: ${event.reason}\n`);
        process.exitCode = 125;
      }
      if (event.type === "exit") {
        finished = true;
        process.exitCode = event.code ?? 128;
        socket.end();
      }
    }
  });
  socket.on("error", () => {
    process.stderr.write("u4-build: worker unavailable\n");
    process.exitCode = 125;
  });
  socket.on("close", () => {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (!finished) {
      process.stderr.write("u4-build: command interrupted; it was not replayed\n");
      process.exitCode = 125;
    }
  });
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "serve") {
    const worker = await startWorker({
      socketPath: "/run/u4-build/worker.sock",
      workspaceRoot: "/workspace",
      buildRoot: "/build",
      home: "/cache/home",
      cache: "/cache",
    });
    const stop = async () => {
      await worker.close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } else await runClient();
}
