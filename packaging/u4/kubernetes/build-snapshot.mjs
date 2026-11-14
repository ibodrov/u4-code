import * as NodeFS from "node:fs";
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
const exists = async (path) =>
  NodeFSP.lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const safe = (source) => [
  "-c",
  `safe.directory=${source}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];
const git = async (args, env, signal) => {
  try {
    return await exec("git", args, { env, signal, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    signal?.throwIfAborted();
    throw new PreparationError("git-failed");
  }
};
const repository = async (workspaceRoot, source, env, signal) => {
  try {
    const contained = async (path) => {
      if (!within(workspaceRoot, path)) throw new PreparationError("metadata-outside-source");
      const real = await NodeFSP.realpath(path);
      if (!within(workspaceRoot, real)) throw new PreparationError("metadata-outside-source");
      return real;
    };
    const readPointer = async (path) => {
      const real = await contained(path);
      if ((await NodeFSP.stat(real)).size > 8192) throw new PreparationError("git-failed");
      const value = (await NodeFSP.readFile(real, "utf8")).trim();
      if (value.length > 8192 || value.includes("\n")) throw new PreparationError("git-failed");
      return value;
    };
    let directory = await contained(NodePath.join(source, ".git"));
    if (!(await NodeFSP.stat(directory)).isDirectory()) {
      const pointer = /^gitdir: (.+)$/.exec(await readPointer(directory));
      if (!pointer) throw new PreparationError("git-failed");
      directory = await contained(NodePath.resolve(source, pointer[1]));
    }
    const common = NodePath.join(directory, "commondir");
    const commonDirectory = (await exists(common))
      ? await contained(NodePath.resolve(directory, await readPointer(common)))
      : directory;
    const objects = await contained(NodePath.join(commonDirectory, "objects"));
    const alternates = NodePath.join(objects, "info/alternates");
    if (await exists(alternates)) {
      // Bundle imports are independent; do not read an external source object store.
      if (await readPointer(alternates)) throw new PreparationError("metadata-outside-source");
    }
    const paths = (
      await git(
        [
          ...safe(source),
          "-C",
          source,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
          "--absolute-git-dir",
        ],
        env,
        signal,
      )
    ).stdout
      .trim()
      .split("\n");
    for (const path of paths) await contained(path);
    const tracked = new Set(),
      parents = new Set(),
      gitlinks = new Set();
    const index = (
      await git([...safe(source), "-C", source, "ls-files", "--stage", "-z"], env, signal)
    ).stdout;
    for (const record of index.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) [a-f0-9]+ [0-3]\t([\s\S]+)$/.exec(record);
      if (!match) throw new PreparationError("git-failed");
      tracked.add(match[2]);
      for (const parent of ancestors(match[2])) parents.add(parent);
      if (match[1] === "160000") gitlinks.add(match[2]);
    }
    return { source, paths, tracked, parents, gitlinks };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PreparationError || error.name === "AbortError") throw error;
    throw new PreparationError("git-failed");
  }
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
const ignoredPaths = (source, paths, env, signal) =>
  new Promise((resolve, reject) => {
    if (!paths.length) {
      resolve(new Set());
      return;
    }
    const child = NodeChildProcess.spawn(
      "git",
      [...safe(source), "-C", source, "check-ignore", "-z", "--stdin"],
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
    child.on("error", () =>
      reject(signal?.aborted ? signal.reason : new PreparationError("git-failed")),
    );
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      code === 0 || code === 1
        ? resolve(
            new Set(
              Buffer.concat(chunks)
                .toString()
                .split("\0")
                .filter(Boolean)
                .map((p) => p.slice(2)),
            ),
          )
        : reject(signal?.aborted ? signal.reason : new PreparationError("git-failed")),
    );
    child.stdin.end(paths.map((p) => "./" + p + "\0").join(""));
  });
const ancestors = (path) =>
  path
    .split(NodePath.sep)
    .slice(0, -1)
    .map((_, i) =>
      path
        .split(NodePath.sep)
        .slice(0, i + 1)
        .join(NodePath.sep),
    );
const classify = async (source, entries, domains, env, signal) => {
  const groups = new Map();
  for (const entry of entries) {
    const absolute = NodePath.join(source, entry.path);
    const domain = domains.find((d) => absolute !== d.source && within(d.source, absolute));
    if (!domain) throw new PreparationError("git-failed");
    const paths = groups.get(domain) ?? [];
    paths.push(NodePath.relative(domain.source, absolute));
    groups.set(domain, paths);
  }
  const ignored = new Set();
  for (const [domain, paths] of groups) {
    for (const path of await ignoredPaths(domain.source, paths, env, signal))
      ignored.add(NodePath.relative(source, NodePath.join(domain.source, path)));
  }
  return ignored;
};
const selectSource = async (workspaceRoot, source, env, signal) => {
  const root = await repository(workspaceRoot, source, env, signal),
    domains = [root],
    entries = [];
  const walk = async (domain) => {
    let directories = [domain.source];
    while (directories.length) {
      const batch = [];
      for (const directory of directories) {
        for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
          signal?.throwIfAborted();
          if (entry.name === ".git") continue;
          const absolute = NodePath.join(directory, entry.name);
          batch.push({
            path: NodePath.relative(source, absolute),
            relative: NodePath.relative(domain.source, absolute),
            absolute,
            directory: entry.isDirectory(),
            file: entry.isFile(),
            link: entry.isSymbolicLink(),
          });
        }
      }
      const ignored = await ignoredPaths(
        domain.source,
        batch.map((e) => e.relative),
        env,
        signal,
      );
      directories = [];
      for (const entry of batch) {
        const tracked = domain.tracked.has(entry.relative) || domain.parents.has(entry.relative);
        if (ignored.has(entry.relative) && !tracked) continue;
        entries.push(entry);
        if (entries.length > 200000) throw new PreparationError("snapshot-limit");
        if (!entry.directory) continue;
        if (
          (domain.gitlinks.has(entry.relative) || !domain.parents.has(entry.relative)) &&
          (await exists(NodePath.join(entry.absolute, ".git")))
        ) {
          const nested = await repository(workspaceRoot, entry.absolute, env, signal);
          domains.push(nested);
          await walk(nested);
        } else directories.push(entry.absolute);
      }
    }
  };
  await walk(root);
  domains.sort((a, b) => b.source.length - a.source.length);
  return { root, domains, entries };
};
const discardedName =
  /^\.discard-[a-f0-9]{24}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const removeObsolete = async (path) => {
  const remove = async (entry) => {
    let handle;
    try {
      // Linux O_PATH pins even mode-000 directories; NOFOLLOW keeps chmod on that exact inode.
      handle = await NodeFSP.open(
        entry,
        0x200000 | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "ENOTDIR" && error.code !== "ELOOP") throw error;
      await NodeFSP.unlink(entry);
      return;
    }
    try {
      const stat = await handle.stat();
      if (stat.uid !== process.getuid())
        throw Object.assign(new Error(), { code: "FOREIGN_OWNER" });
      const pinned = `/proc/self/fd/${handle.fd}`;
      await NodeFSP.chmod(pinned, (stat.mode & 0o777) | 0o700);
      for await (const child of await NodeFSP.opendir(pinned))
        await remove(NodePath.join(pinned, child.name));
      await NodeFSP.rmdir(entry);
    } finally {
      await handle.close();
    }
  };
  try {
    await remove(path);
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.code) ? error.code : "UNKNOWN";
    console.error(`u4-build: obsolete-copy-cleanup-failed ${NodePath.basename(path)} ${code}`);
  }
};
const sweepObsolete = async (buildRoot) => {
  for (const name of await NodeFSP.readdir(buildRoot))
    if (discardedName.test(name)) await removeObsolete(NodePath.join(buildRoot, name));
};
export async function prepareSnapshot(workspaceRoot, cwd, buildRoot, signal) {
  let stage = "source-unreadable",
    temporary,
    discarded;
  try {
    signal?.throwIfAborted();
    let source = cwd;
    while (!(await exists(NodePath.join(source, ".git")))) {
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
    await sweepObsolete(buildRoot);
    const {
      root,
      domains,
      entries: selected,
    } = await selectSource(workspaceRoot, source, env, signal);
    let bytes = 0;
    for (const entry of selected) {
      if (!entry.directory && !entry.file && !entry.link)
        throw new PreparationError("unsupported-entry");
      if (entry.file) {
        bytes += (await NodeFSP.lstat(NodePath.join(source, entry.path))).size;
        if (bytes > 512 * 1024 * 1024) throw new PreparationError("snapshot-limit");
      }
    }
    const id = NodeCrypto.createHash("sha256").update(source).digest("hex").slice(0, 24),
      destination = NodePath.join(buildRoot, id);
    temporary = await NodeFSP.mkdtemp(NodePath.join(buildRoot, ".prepare-"));
    stage = "copy-failed";
    const head = (
      await git([...safe(source), "-C", source, "rev-parse", "--verify", "HEAD"], env, signal)
    ).stdout.trim();
    const branch = (
      await git(
        [...safe(source), "-C", source, "rev-parse", "--symbolic-full-name", "HEAD"],
        env,
        signal,
      )
    ).stdout.trim();
    const configDirectory = await NodeFSP.mkdtemp("/tmp/u4-builder-git-");
    try {
      const config = NodePath.join(configDirectory, "config");
      for (const path of new Set([source, ...root.paths]))
        await git(["config", "--file", config, "--add", "safe.directory", path], env, signal);
      await git(
        ["clone", "--no-local", "--no-hardlinks", "--no-checkout", source, temporary],
        { ...env, GIT_CONFIG_GLOBAL: config },
        signal,
      );
    } finally {
      await NodeFSP.rm(configDirectory, { recursive: true, force: true });
    }
    if (branch === "HEAD")
      await git(["-C", temporary, "update-ref", "--no-deref", "HEAD", head], env, signal);
    else {
      await git(["-C", temporary, "update-ref", branch, head], env, signal);
      await git(["-C", temporary, "symbolic-ref", "HEAD", branch], env, signal);
    }
    await git(["-C", temporary, "reset", "--mixed", "HEAD"], env, signal);
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
    try {
      const stat = await exists(destination);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        const leaves = new Set(selected.filter((e) => !e.directory).map((e) => e.path));
        const sourcePaths = new Set(selected.map((e) => e.path));
        const old = (await list(destination, signal)).filter(
          (e) =>
            e.file && !sourcePaths.has(e.path) && !ancestors(e.path).some((p) => leaves.has(p)),
        );
        const ignoredOld = await classify(source, old, domains, env, signal);
        for (const entry of old) {
          if (!ignoredOld.has(entry.path)) continue;
          signal?.throwIfAborted();
          const target = NodePath.join(temporary, entry.path);
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          await NodeFSP.rename(NodePath.join(destination, entry.path), target);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === "AbortError") throw error;
      // Old outputs are optional, but a broken trusted repository still fails preparation.
      if (error instanceof PreparationError && error.reason === "git-failed")
        await classify(source, selected, domains, env, signal);
    }
    signal?.throwIfAborted();
    discarded = NodePath.join(buildRoot, `.discard-${id}-${NodeCrypto.randomUUID()}`);
    if (await exists(destination)) await NodeFSP.rename(destination, discarded);
    await NodeFSP.rename(temporary, destination);
    temporary = undefined;
    await removeObsolete(discarded);
    discarded = undefined;
    await NodeFSP.rm(NodePath.join(buildRoot, `${id}.json`), { force: true }).catch(() => {});
    return NodePath.join(destination, NodePath.relative(source, cwd));
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === "AbortError") throw error;
    throw error instanceof PreparationError ? error : new PreparationError(stage);
  } finally {
    if (discarded) await removeObsolete(discarded);
    if (temporary) await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
