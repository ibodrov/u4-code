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
    for (const initialized of [false, true])
      for (const kind of ["file", "dangling", "directory-link", "file-link"]) {
        const volume = NodePath.join(root, `${initialized}-${kind}`);
        await NodeFSP.mkdir(NodePath.join(volume, "cache"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(volume, "cache/mvn"), "old-cache", { mode: 0o755 });
        if (initialized) {
          prepareVolume(volume, "1");
          await NodeFSP.chmod(NodePath.join(volume, "cache/mvn"), 0o600);
          await NodeFSP.rm(NodePath.join(volume, "cache/home"), { recursive: true });
        }
        const home = NodePath.join(volume, "cache/home");
        const target = NodePath.join(root, `unrelated-${initialized}-${kind}`);
        if (kind === "directory-link") await NodeFSP.mkdir(target);
        if (kind === "file-link")
          await NodeFSP.writeFile(target, "preserve target", { mode: 0o600 });
        if (kind === "file") await NodeFSP.writeFile(home, "preserve entry");
        else await NodeFSP.symlink(target, home);
        prepareVolume(volume, "3");
        expect((await NodeFSP.lstat(home)).isDirectory()).toBe(true);
        expect((await NodeFSP.lstat(home)).isSymbolicLink()).toBe(false);
        const quarantined = (await NodeFSP.readdir(NodePath.join(volume, "cache"))).filter((x) =>
          x.startsWith("home-quarantine-"),
        );
        expect(quarantined).toHaveLength(1);
        const entry = NodePath.join(volume, "cache", quarantined[0]);
        if (kind === "file") expect(await NodeFSP.readFile(entry, "utf8")).toBe("preserve entry");
        else expect(await NodeFSP.readlink(entry)).toBe(target);
        if (kind === "file-link") {
          expect(await NodeFSP.readFile(target, "utf8")).toBe("preserve target");
          expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o600);
        }
        expect(
          await NodeFSP.readFile(NodePath.join(volume, "state/build-permissions-v2"), "utf8"),
        ).toBe("2");
        const mode = (await NodeFSP.stat(NodePath.join(volume, "cache/mvn"))).mode & 0o777;
        expect(mode).toBe(initialized ? 0o600 : 0o770);
        prepareVolume(volume, "4");
        expect((await NodeFSP.stat(NodePath.join(volume, "cache/mvn"))).mode & 0o777).toBe(mode);
      }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
