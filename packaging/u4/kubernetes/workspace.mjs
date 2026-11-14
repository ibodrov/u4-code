import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
const sha = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
export function runWorkspace({ action, base, arg, exportId, root = "/workspace" }) {
  if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("invalid base");
  if (action === "import") {
    if (!/^[a-f0-9]{64}$/.test(arg ?? "") || sha(`${root}/source.bundle`) !== arg)
      throw new Error("bundle digest mismatch");
    if (NodeFS.existsSync(`${root}/repo/.git`)) {
      if (git(`${root}/repo`, "rev-parse", "refs/heads/u4-base") !== base)
        throw new Error("existing repository base mismatch");
    } else {
      NodeFS.mkdirSync(`${root}/importing`, { recursive: true });
      git(`${root}/importing`, "init");
      git(`${root}/importing`, "bundle", "verify", `${root}/source.bundle`);
      git(`${root}/importing`, "fetch", `${root}/source.bundle`, "HEAD:refs/heads/u4-base");
      if (git(`${root}/importing`, "rev-parse", "refs/heads/u4-base") !== base)
        throw new Error("snapshot head mismatch");
      git(`${root}/importing`, "checkout", "u4-base");
      git(`${root}/importing`, "config", "credential.helper", "");
      git(`${root}/importing`, "config", "core.hooksPath", "/dev/null");
      git(`${root}/importing`, "config", "user.name", "U4 workspace");
      git(`${root}/importing`, "config", "user.email", "workspace@u4.invalid");
      if (NodeFS.existsSync(`${root}/repo`)) {
        if (NodeFS.readdirSync(`${root}/repo`).length) throw new Error("destination not empty");
        NodeFS.rmdirSync(`${root}/repo`);
      }
      NodeFS.renameSync(`${root}/importing`, `${root}/repo`);
    }
    if (exportId) {
      if (!/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(exportId))
        throw new Error("invalid source remote");
      const remotes = git(`${root}/repo`, "remote").split("\n");
      if (remotes.includes("origin")) {
        if (git(`${root}/repo`, "remote", "get-url", "origin") !== exportId)
          throw new Error("source remote mismatch");
      } else git(`${root}/repo`, "remote", "add", "origin", exportId);
    }
    return { base, sha256: arg, path: `${root}/repo` };
  } else if (action === "export") {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,120}$/.test(arg ?? "") ||
      !/^[a-f0-9-]{36}$/.test(exportId ?? "")
    )
      throw new Error("invalid export");
    const cwd = `${root}/repo`,
      ref = `refs/heads/${arg}`;
    git(cwd, "check-ref-format", ref);
    const head = git(cwd, "rev-parse", `${ref}^{commit}`);
    git(cwd, "merge-base", "--is-ancestor", base, head);
    const checkpoints = git(
      cwd,
      "for-each-ref",
      "--format=%(refname)",
      "refs/t3/orchestration-v2/checkpoints",
    )
      .split("\n")
      .filter(Boolean);
    const path = `${root}/${exportId}.bundle`;
    git(cwd, "bundle", "create", path, ref, ...checkpoints);
    if (NodeFS.statSync(path).size > 256 * 1024 * 1024) {
      NodeFS.unlinkSync(path);
      throw new Error("bundle exceeds transfer limit");
    }
    return { head, base, sha256: sha(path), path };
  } else throw new Error("unknown operation");
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [action, base, arg, exportId] = process.argv.slice(2);
  console.log(JSON.stringify(runWorkspace({ action, base, arg, exportId })));
}
