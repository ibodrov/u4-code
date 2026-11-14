import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { prepareVolume } from "./prepare-volume.mjs";
import { runWorkspace } from "./workspace.mjs";
it("imports a verified independent source with its public origin, refuses identity changes and exports dotted branches and checkpoint refs", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-workspace-helper-"));
  try {
    const source = NodePath.join(root, "source"),
      target = NodePath.join(root, "workspace");
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(target);
    const git = (cwd, ...args) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    await NodeFSP.writeFile(NodePath.join(source, "tracked.txt"), "source\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "source");
    const base = git(source, "rev-parse", "HEAD"),
      bundle = NodePath.join(target, "source.bundle");
    git(source, "bundle", "create", bundle, "HEAD");
    const arg = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(bundle))
      .digest("hex");
    expect(() =>
      runWorkspace({ action: "import", base, arg: "0".repeat(64), root: target }),
    ).toThrow("digest mismatch");
    const remote = "https://github.com/walmartlabs/concord.git";
    const imported = runWorkspace({ action: "import", base, arg, exportId: remote, root: target });
    const repo = imported.path;
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(git(repo, "remote", "get-url", "origin")).toBe(remote);
    expect((await NodeFSP.stat(NodePath.join(repo, ".git"))).isDirectory()).toBe(true);
    expect(runWorkspace({ action: "import", base, arg, exportId: remote, root: target })).toEqual(
      imported,
    );
    expect(() =>
      runWorkspace({ action: "import", base: "0".repeat(40), arg, root: target }),
    ).toThrow("base mismatch");
    expect(() =>
      runWorkspace({
        action: "import",
        base,
        arg,
        exportId: "https://different.invalid/repo",
        root: target,
      }),
    ).toThrow("remote mismatch");
    git(repo, "checkout", "-b", "release/1.2");
    await NodeFSP.writeFile(NodePath.join(repo, "tracked.txt"), "result\n");
    git(repo, "commit", "-am", "result");
    const head = git(repo, "rev-parse", "HEAD"),
      checkpoint = "refs/t3/orchestration-v2/checkpoints/test/ordinal/1";
    git(repo, "update-ref", checkpoint, head);
    const result = runWorkspace({
      action: "export",
      base,
      arg: "release/1.2",
      exportId: "12345678-1234-1234-1234-123456789abc",
      root: target,
    });
    expect(result.head).toBe(head);
    expect(git(repo, "bundle", "list-heads", result.path).split("\n")).toEqual([
      `${head} refs/heads/release/1.2`,
      `${head} ${checkpoint}`,
    ]);
    expect(() =>
      runWorkspace({
        action: "export",
        base,
        arg: "release/../wrong",
        exportId: "12345678-1234-1234-1234-123456789abc",
        root: target,
      }),
    ).toThrow();
    expect(git(source, "status", "--porcelain")).toBe("");
    expect(git(source, "rev-parse", "HEAD")).toBe(base);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("migrates only old caches once, preserves executable tools and keeps migration and provider state server-only", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-volume-permissions-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "cache"));
    await NodeFSP.writeFile(NodePath.join(root, "cache/mvn"), "#!/bin/sh\n", { mode: 0o755 });
    prepareVolume(root, "1");
    expect((await NodeFSP.stat(NodePath.join(root, "cache/mvn"))).mode & 0o777).toBe(0o770);
    expect((await NodeFSP.stat(NodePath.join(root, "provider"))).mode & 0o777).toBe(0o700);
    expect((await NodeFSP.stat(NodePath.join(root, "state"))).mode & 0o777).toBe(0o700);
    await NodeFSP.chmod(NodePath.join(root, "cache/mvn"), 0o600);
    prepareVolume(root, "2");
    expect((await NodeFSP.stat(NodePath.join(root, "cache/mvn"))).mode & 0o777).toBe(0o600);
    expect(await NodeFSP.readFile(NodePath.join(root, "state/generation"), "utf8")).toBe("2");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
