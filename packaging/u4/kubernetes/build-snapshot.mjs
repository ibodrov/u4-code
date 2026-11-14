import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const within = (root, path) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};
export async function prepareSnapshot(workspaceRoot, cwd, buildRoot, signal) {
  signal?.throwIfAborted();
  let source = cwd;
  while (!(await NodeFSP.lstat(NodePath.join(source, ".git")).catch(() => null))) {
    if (source === workspaceRoot) throw new Error("run from a source Git worktree");
    source = NodePath.dirname(source);
    if (!within(workspaceRoot, source)) throw new Error("source outside workspace");
  }
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const gitPaths = (
    await exec(
      "git",
      [
        "-c",
        `safe.directory=${source}`,
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
    throw new Error("Git metadata outside source mount");
  const trust = [source, ...gitPaths].flatMap((path) => ["-c", `safe.directory=${path}`]);
  const head = (
    await exec("git", [...trust, "-C", source, "rev-parse", "HEAD"], { env, signal })
  ).stdout.trim();
  const hash = NodeCrypto.createHash("sha256").update(head);
  let bytes = 0;
  const walk = async (directory) => {
    for (const entry of (await NodeFSP.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      signal?.throwIfAborted();
      if (entry.name === ".git") continue;
      const path = NodePath.join(directory, entry.name);
      hash.update(NodePath.relative(source, path) + "\0");
      if (entry.isSymbolicLink()) hash.update("link\0" + (await NodeFSP.readlink(path)));
      else if (entry.isDirectory()) {
        hash.update("dir\0");
        await walk(path);
      } else if (entry.isFile()) {
        const stat = await NodeFSP.stat(path);
        bytes += stat.size;
        if (bytes > 512 * 1024 * 1024) throw new Error("source snapshot exceeds limit");
        hash.update(`${stat.mode}\0`);
        hash.update(await NodeFSP.readFile(path));
      } else throw new Error("unsupported source entry");
    }
  };
  await walk(source);
  const fingerprint = hash.digest("hex");
  const id = NodeCrypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
  const destination = NodePath.join(buildRoot, id);
  const manifest = NodePath.join(buildRoot, `${id}.json`);
  const current = await NodeFSP.readFile(manifest, "utf8").catch(() => "");
  const stat = await NodeFSP.lstat(destination).catch(() => null);
  if (current !== fingerprint || !stat?.isDirectory() || stat.isSymbolicLink()) {
    await NodeFSP.rm(destination, { recursive: true, force: true });
    // Never hardlink metadata or copy a worktree's absolute gitdir pointer into the build copy.
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
        ["clone", "--no-local", "--no-hardlinks", "--no-checkout", source, destination],
        { env: { ...env, GIT_CONFIG_GLOBAL: config }, signal },
      );
    } finally {
      await NodeFSP.rm(configDirectory, { recursive: true, force: true });
    }
    await exec("git", ["-C", destination, "reset", "--mixed", "HEAD"], { env, signal });
    await NodeFSP.cp(source, destination, {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (path) => {
        signal?.throwIfAborted();
        return NodePath.basename(path) !== ".git";
      },
    });
    await NodeFSP.writeFile(manifest, fingerprint);
  }
  return NodePath.join(destination, NodePath.relative(source, cwd));
}
