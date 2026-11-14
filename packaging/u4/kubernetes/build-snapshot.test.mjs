import { it, expect, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { prepareSnapshot } from "./build-snapshot.mjs";

const io = vi.hoisted(() => ({ read: null }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return { ...actual, readdir: async (...args) => io.read?.(...args) ?? actual.readdir(...args) };
});
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
async function fixture() {
  io.read = null;
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
  for (const reason of ["read-failure", "entry-limit"]) {
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
