import { it, expect, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { prepareSnapshot } from "./build-snapshot.mjs";

const io = vi.hoisted(() => ({ read: null, open: null }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    readdir: async (...args) => io.read?.(...args) ?? actual.readdir(...args),
    open: async (...args) => io.open?.(...args) ?? actual.open(...args),
  };
});
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
async function fixture() {
  io.read = null;
  io.open = null;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-source-boundary-"));
  const source = NodePath.join(root, "source"),
    build = NodePath.join(root, "build");
  await NodeFSP.mkdir(source);
  await NodeFSP.mkdir(build);
  const git = async (cwd, ...args) =>
    (
      await exec("git", [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        cwd,
        ...args,
      ])
    ).stdout.trim();
  await git(source, "init", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(source, "file"), "trusted\n");
  await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), "target/\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  return {
    root,
    source,
    build,
    git,
    prepare: (signal) => prepareSnapshot(root, source, build, signal),
    async [Symbol.asyncDispose]() {
      io.read = null;
      io.open = null;
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}
it("filters old paths below source symlinks before Git and repeatedly recovers optional output failures", async () => {
  await using f = await fixture();
  await NodeFSP.symlink("file", NodePath.join(f.source, "link"));
  const first = await f.prepare();
  await NodeFSP.rm(NodePath.join(first, "link"));
  await NodeFSP.mkdir(NodePath.join(first, "link"));
  await NodeFSP.writeFile(NodePath.join(first, "link/generated"), "untrusted");
  for (const _ of [1, 2]) {
    expect(await f.prepare()).toBe(first);
    expect(await NodeFSP.readlink(NodePath.join(first, "link"))).toBe("file");
  }
  await NodeFSP.mkdir(NodePath.join(f.source, "changing"));
  await NodeFSP.writeFile(NodePath.join(f.source, "changing/file"), "before");
  await f.prepare();
  await NodeFSP.rm(NodePath.join(f.source, "changing"), { recursive: true });
  await NodeFSP.symlink("file", NodePath.join(f.source, "changing"));
  for (const _ of [1, 2]) {
    await f.prepare();
    expect(await NodeFSP.readlink(NodePath.join(first, "changing"))).toBe("file");
  }
  // An uninitialized gitlink rejects old children in the parent's check-ignore domain.
  const head = await f.git(f.source, "rev-parse", "HEAD");
  await f.git(f.source, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
  await NodeFSP.mkdir(NodePath.join(f.source, "sub"));
  await NodeFSP.mkdir(NodePath.join(first, "sub/target"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(first, "sub/target/output"), "discard");
  for (const _ of [1, 2]) expect(await f.prepare()).toBe(first);
  expect(await NodeFSP.readdir(NodePath.join(first, "sub"))).toEqual([]);
  await NodeFSP.mkdir(NodePath.join(f.build, NodePath.basename(first) + ".json"));
  await exec("mkfifo", [NodePath.join(first, "old-fifo")]);
  expect(await f.prepare()).toBe(first);
  for (const reason of ["read-failure", "entry-limit", "entry-limit"]) {
    io.read = (p) =>
      p === first
        ? reason === "read-failure"
          ? Promise.reject(Object.assign(new Error("old cache"), { code: "EACCES" }))
          : Promise.resolve(
              Array.from({ length: 200001 }, (_, i) => ({
                name: String(i),
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              })),
            )
        : null;
    expect(await f.prepare()).toBe(first);
    io.read = null;
    expect((await NodeFSP.readdir(f.build)).filter((p) => p.startsWith(".discard-"))).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(first, "file"), "utf8")).toBe("trusted\n");
  }
});
it("classifies checked-out submodules and nested repositories in their own Git domains", async () => {
  await using f = await fixture();
  const module = NodePath.join(f.root, "module");
  await NodeFSP.mkdir(module);
  await f.git(module, "init", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(module, "kept.txt"), "module bytes\n");
  await NodeFSP.writeFile(NodePath.join(module, ".gitignore"), "target/\n");
  await f.git(module, "add", ".");
  await f.git(module, "commit", "-m", "module");
  await f.git(f.source, "-c", "protocol.file.allow=always", "submodule", "add", module, "sub");
  const nested = NodePath.join(f.source, "nested");
  await NodeFSP.mkdir(nested);
  await f.git(nested, "init", "-b", "main");
  await NodeFSP.writeFile(NodePath.join(nested, "kept.txt"), "nested bytes\n");
  await f.git(nested, "add", ".");
  await f.git(nested, "commit", "-m", "nested");
  await NodeFSP.appendFile(NodePath.join(f.source, ".gitignore"), "sub/*.txt\nnested/*.txt\n");
  await NodeFSP.mkdir(NodePath.join(f.source, "sub/target"));
  await NodeFSP.writeFile(NodePath.join(f.source, "sub/target/ignored"), "not copied");
  for (const _ of [1, 2]) {
    const copy = await f.prepare();
    expect(await NodeFSP.readFile(NodePath.join(copy, "sub/kept.txt"), "utf8")).toBe(
      "module bytes\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(copy, "nested/kept.txt"), "utf8")).toBe(
      "nested bytes\n",
    );
    expect(await NodeFSP.readdir(NodePath.join(copy, "sub"))).not.toContain(".git");
    expect(await NodeFSP.readdir(NodePath.join(copy, "nested"))).not.toContain(".git");
    expect(await NodeFSP.readdir(NodePath.join(copy, "sub"))).not.toContain("target");
  }
  await NodeFSP.writeFile(
    NodePath.join(f.source, "sub/.git"),
    `gitdir: ${NodePath.join(NodeOS.tmpdir(), "outside-allowed-source")}\n`,
  );
  await expect(f.prepare()).rejects.toMatchObject({ reason: "metadata-outside-source" });
});
it("preserves aborts and distinguishes trusted Git failures from optional old-output errors", async () => {
  await using f = await fixture();
  const copy = await f.prepare();
  const controller = new AbortController(),
    aborted = new Error("owned abort");
  io.read = (p) => {
    if (p === copy) {
      controller.abort(aborted);
      return Promise.reject(new Error("old cache failure"));
    }
    return null;
  };
  await expect(f.prepare(controller.signal)).rejects.toBe(aborted);
  io.read = null;
  await NodeFSP.mkdir(NodePath.join(copy, "target"));
  await NodeFSP.writeFile(NodePath.join(copy, "target/output"), "optional old output");
  const index = NodePath.join(f.source, ".git/index"),
    saved = await NodeFSP.readFile(index);
  io.read = (p) =>
    p === copy
      ? (async () => {
          await NodeFSP.writeFile(index, "invalid trusted index");
          io.read = null;
          return NodeFSP.readdir(copy, { withFileTypes: true });
        })()
      : null;
  try {
    await expect(f.prepare()).rejects.toMatchObject({ reason: "git-failed" });
  } finally {
    io.read = null;
    await NodeFSP.writeFile(index, saved);
  }
  expect(await f.prepare()).toBe(copy);
});

it("keeps detached and linked-worktree HEAD, tags and parent history independently usable offline", async () => {
  await using f = await fixture();
  await f.git(f.source, "tag", "fixture-base");
  await f.git(f.source, "tag", "main");
  expect(await f.git(await f.prepare(), "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  await NodeFSP.writeFile(NodePath.join(f.source, "file"), "second commit\n");
  await f.git(f.source, "commit", "-am", "second");
  const head = await f.git(f.source, "rev-parse", "HEAD");
  await f.git(f.source, "checkout", "--detach", head);
  const linked = NodePath.join(f.root, "linked");
  await f.git(f.source, "worktree", "add", "--detach", linked, head);
  const first = await f.prepare();
  const description = await f.git(f.source, "describe", "--tags", "--always");
  await f.git(f.source, "checkout", "main");
  await NodeFSP.writeFile(NodePath.join(f.source, "file"), "third commit on primary\n");
  await f.git(f.source, "commit", "-am", "primary advances");
  const copies = [first, await prepareSnapshot(f.root, linked, f.build)];
  await NodeFSP.rename(f.source, NodePath.join(f.root, "offline-source"));
  for (const copy of copies) {
    expect(await f.git(copy, "rev-parse", "HEAD")).toBe(head);
    expect(await f.git(copy, "branch", "--show-current")).toBe("");
    expect(await f.git(copy, "describe", "--tags", "--always")).toBe(description);
    expect(await f.git(copy, "show", "HEAD^:file")).toBe("trusted");
    expect(await f.git(copy, "rev-parse", "--is-shallow-repository")).toBe("false");
    await f.git(copy, "fsck", "--no-reflogs");
    await expect(
      NodeFSP.stat(NodePath.join(copy, ".git/objects/info/alternates")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await NodeFSP.readdir(NodePath.join(copy, ".git/objects/pack"))).filter((p) =>
        p.endsWith(".promisor"),
      ),
    ).toEqual([]);
  }
});

it("keeps parent-tracked source ahead of nested metadata and child ignore rules", async () => {
  await using f = await fixture();
  for (const directory of ["vendor", "ignored"]) {
    await NodeFSP.mkdir(NodePath.join(f.source, directory));
    await NodeFSP.writeFile(NodePath.join(f.source, directory, "tracked.c"), "parent bytes\n");
  }
  await NodeFSP.appendFile(NodePath.join(f.source, ".gitignore"), "ignored/\n");
  await f.git(f.source, "add", "-f", "vendor/tracked.c", "ignored/tracked.c");
  for (const directory of ["vendor", "ignored"]) {
    await f.git(NodePath.join(f.source, directory), "init");
    await NodeFSP.writeFile(NodePath.join(f.source, directory, ".git/info/exclude"), "*.c\n");
  }
  for (const _ of [1, 2]) {
    const copy = await f.prepare();
    for (const directory of ["vendor", "ignored"])
      expect(await NodeFSP.readFile(NodePath.join(copy, directory, "tracked.c"), "utf8")).toBe(
        "parent bytes\n",
      );
  }
});
it("skips ignored stale worktrees and shared clones before validating their metadata", async () => {
  await using f = await fixture();
  await f.git(
    f.source,
    "worktree",
    "add",
    "--detach",
    NodePath.join(f.source, "target/stale"),
    "HEAD",
  );
  await NodeFSP.rm(NodePath.join(f.source, ".git/worktrees/stale"), { recursive: true });
  await f.git(f.source, "clone", "--shared", f.source, NodePath.join(f.source, "target/shared"));
  for (const _ of [1, 2]) expect(await NodeFSP.readdir(await f.prepare())).not.toContain("target");
});
it("uses literal NUL-delimited paths for colon magic, spaces and newlines", async () => {
  await using f = await fixture();
  const names = [":(exclude)x", ":with space\nand newline"];
  for (const name of names) await NodeFSP.writeFile(NodePath.join(f.source, name), name);
  await f.git(f.source, "add", "--", "./" + names[0]);
  const ignored = ":(glob)cache";
  await NodeFSP.appendFile(NodePath.join(f.source, ".gitignore"), ignored + "/\n");
  await NodeFSP.mkdir(NodePath.join(f.source, ignored));
  await NodeFSP.writeFile(NodePath.join(f.source, ignored, "output\nwith space"), "source ignored");
  const copy = await f.prepare();
  await NodeFSP.mkdir(NodePath.join(copy, ignored));
  await NodeFSP.writeFile(NodePath.join(copy, ignored, "output\nwith space"), "old optional");
  for (const _ of [1, 2]) {
    await f.prepare();
    for (const name of names)
      expect(await NodeFSP.readFile(NodePath.join(copy, name), "utf8")).toBe(name);
    expect(await NodeFSP.readFile(NodePath.join(copy, ignored, "output\nwith space"), "utf8")).toBe(
      "old optional",
    );
  }
});
it("cleans restrictive obsolete directories and symlinks only within owned discard names", async () => {
  await using f = await fixture();
  const copy = await f.prepare();
  const marker = NodePath.join(f.root, "outside");
  await NodeFSP.mkdir(marker);
  await NodeFSP.writeFile(NodePath.join(marker, "keep"), "untouched");
  const originalMode = (await NodeFSP.stat(marker)).mode;
  const owned = ".discard-" + NodePath.basename(copy) + "-";
  const stale = NodePath.join(f.build, owned + "11111111-1111-4111-8111-111111111111");
  const link = NodePath.join(f.build, owned + "22222222-2222-4222-8222-222222222222");
  const unrelated = NodePath.join(f.build, ".discard-unowned");
  await NodeFSP.mkdir(stale);
  await NodeFSP.symlink(marker, NodePath.join(stale, "outside"));
  await NodeFSP.writeFile(NodePath.join(stale, "old"), "obsolete");
  await NodeFSP.chmod(stale, 0);
  await NodeFSP.symlink(marker, link);
  await NodeFSP.mkdir(unrelated);
  using warning = vi.spyOn(console, "error").mockImplementation(() => {});
  io.open = (p) =>
    p === stale ? Promise.reject(Object.assign(new Error(), { code: "EACCES" })) : null;
  expect(await f.prepare()).toBe(copy);
  expect(warning).toHaveBeenCalledWith(
    `u4-build: obsolete-copy-cleanup-failed ${NodePath.basename(stale)} EACCES`,
  );
  expect((await NodeFSP.lstat(stale)).isDirectory()).toBe(true);
  io.open = null;
  try {
    for (const _ of [1, 2]) {
      expect(await f.prepare()).toBe(copy);
      expect(await NodeFSP.readFile(NodePath.join(marker, "keep"), "utf8")).toBe("untouched");
      expect((await NodeFSP.stat(marker)).mode).toBe(originalMode);
      expect((await NodeFSP.readdir(f.build)).filter((p) => p.startsWith(owned))).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(copy, "file"), "utf8")).toBe("trusted\n");
      expect((await NodeFSP.stat(unrelated)).isDirectory()).toBe(true);
    }
  } finally {
    await NodeFSP.chmod(stale, 0o700).catch(() => {});
  }
});
