import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export class PreparationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const within = (root, path) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};
const list = async (root, signal) => {
  const entries = [];
  const walk = async (relative) => {
    for (const entry of await NodeFSP.readdir(NodePath.join(root, relative), {
      withFileTypes: true,
    })) {
      signal?.throwIfAborted();
      if (entry.name === ".git") continue;
      const path = NodePath.join(relative, entry.name);
      entries.push({
        path,
        directory: entry.isDirectory(),
        file: entry.isFile(),
        link: entry.isSymbolicLink(),
      });
      if (entries.length > 200000) throw new PreparationError("snapshot-limit");
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk("");
  return entries;
};
const ignoredPaths = (source, paths, args, env, signal) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "git",
      [...args, "-C", source, "check-ignore", "-z", "--stdin"],
      { env, signal, stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        child.kill();
        reject(new PreparationError("snapshot-limit"));
      } else chunks.push(chunk);
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      code === 0 || code === 1
        ? resolve(new Set(Buffer.concat(chunks).toString().split("\0").filter(Boolean)))
        : reject(new PreparationError("source-unreadable")),
    );
    child.stdin.end(paths.map((p) => p + "\0").join(""));
  });
export async function prepareSnapshot(workspaceRoot, cwd, buildRoot, signal) {
  let stage = "source-unreadable";
  let temporary;
  try {
    signal?.throwIfAborted();
    let source = cwd;
    while (
      !(await NodeFSP.lstat(NodePath.join(source, ".git")).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      }))
    ) {
      if (source === workspaceRoot) throw new PreparationError("missing-worktree");
      source = NodePath.dirname(source);
      if (!within(workspaceRoot, source)) throw new PreparationError("missing-worktree");
    }
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const safe = [
      "-c",
      `safe.directory=${source}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
    ];
    const gitPaths = (
      await exec(
        "git",
        [
          ...safe,
          "-C",
          source,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
          "--absolute-git-dir",
        ],
        { env, signal },
      )
    ).stdout
      .trim()
      .split("\n");
    if (gitPaths.some((path) => !within(workspaceRoot, path)))
      throw new PreparationError("metadata-outside-source");
    const entries = await list(source, signal);
    const ignored = await ignoredPaths(
      source,
      entries.map((e) => e.path),
      safe,
      env,
      signal,
    );
    const selected = entries.filter((e) => !ignored.has(e.path));
    let bytes = 0;
    for (const entry of selected) {
      if (!entry.directory && !entry.file && !entry.link)
        throw new PreparationError("unsupported-entry");
      if (entry.file) {
        bytes += (await NodeFSP.lstat(NodePath.join(source, entry.path))).size;
        if (bytes > 512 * 1024 * 1024) throw new PreparationError("snapshot-limit");
      }
    }
    const id = NodeCrypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
    const destination = NodePath.join(buildRoot, id);
    temporary = await NodeFSP.mkdtemp(NodePath.join(buildRoot, ".prepare-"));
    stage = "copy-failed";
    const configDirectory = await NodeFSP.mkdtemp("/tmp/u4-builder-git-");
    try {
      const config = NodePath.join(configDirectory, "config");
      for (const path of new Set([source, ...gitPaths]))
        await exec("git", ["config", "--file", config, "--add", "safe.directory", path], {
          env,
          signal,
        });
      await exec(
        "git",
        ["clone", "--no-local", "--no-hardlinks", "--no-checkout", source, temporary],
        { env: { ...env, GIT_CONFIG_GLOBAL: config }, signal },
      );
    } finally {
      await NodeFSP.rm(configDirectory, { recursive: true, force: true });
    }
    await exec("git", ["-C", temporary, "reset", "--mixed", "HEAD"], { env, signal });
    const sourcePaths = new Set(selected.map((e) => e.path));
    const sourceFiles = new Set(selected.filter((e) => !e.directory).map((e) => e.path));
    for (const entry of selected) {
      signal?.throwIfAborted();
      const target = NodePath.join(temporary, entry.path);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      if (entry.directory) await NodeFSP.mkdir(target, { recursive: true });
      else {
        stage = "source-unreadable";
        if (entry.link)
          await NodeFSP.symlink(await NodeFSP.readlink(NodePath.join(source, entry.path)), target);
        else {
          await NodeFSP.copyFile(NodePath.join(source, entry.path), target);
          await NodeFSP.chmod(
            target,
            (await NodeFSP.stat(NodePath.join(source, entry.path))).mode & 0o777,
          );
        }
      }
    }
    stage = "copy-failed";
    const stat = await NodeFSP.lstat(destination).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      const old = await list(destination, signal);
      const ignoredOld = await ignoredPaths(
        source,
        old.map((e) => e.path),
        safe,
        env,
        signal,
      );
      // Only source-owned ignore rules authorize preserving outputs; metadata in /build is untrusted.
      for (const entry of old) {
        if (!entry.file || !ignoredOld.has(entry.path) || sourcePaths.has(entry.path)) continue;
        const parts = entry.path.split(NodePath.sep);
        if (
          parts
            .slice(0, -1)
            .some((_, i) => sourceFiles.has(parts.slice(0, i + 1).join(NodePath.sep)))
        )
          continue;
        const target = NodePath.join(temporary, entry.path);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.rename(NodePath.join(destination, entry.path), target);
      }
    }
    signal?.throwIfAborted();
    await NodeFSP.rm(destination, { recursive: true, force: true });
    await NodeFSP.rename(temporary, destination);
    temporary = undefined;
    await NodeFSP.rm(NodePath.join(buildRoot, `${id}.json`), { force: true });
    return NodePath.join(destination, NodePath.relative(source, cwd));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw error instanceof PreparationError ? error : new PreparationError(stage);
  } finally {
    if (temporary) await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
