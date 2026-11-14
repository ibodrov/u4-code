import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
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
const [action, base, arg, exportId] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("invalid base");
if (action === "import") {
  if (!/^[a-f0-9]{64}$/.test(arg ?? "") || sha("/workspace/source.bundle") !== arg)
    throw new Error("bundle digest mismatch");
  if (NodeFS.existsSync("/workspace/repo/.git")) {
    if (git("/workspace/repo", "rev-parse", "refs/heads/u4-base") !== base)
      throw new Error("existing repository base mismatch");
  } else {
    NodeFS.mkdirSync("/workspace/importing", { recursive: true });
    git("/workspace/importing", "init");
    git("/workspace/importing", "bundle", "verify", "/workspace/source.bundle");
    git("/workspace/importing", "fetch", "/workspace/source.bundle", "HEAD:refs/heads/u4-base");
    if (git("/workspace/importing", "rev-parse", "refs/heads/u4-base") !== base)
      throw new Error("snapshot head mismatch");
    git("/workspace/importing", "checkout", "u4-base");
    git("/workspace/importing", "config", "credential.helper", "");
    git("/workspace/importing", "config", "core.hooksPath", "/dev/null");
    git("/workspace/importing", "config", "user.name", "U4 workspace");
    git("/workspace/importing", "config", "user.email", "workspace@u4.invalid");
    if (NodeFS.existsSync("/workspace/repo")) {
      if (NodeFS.readdirSync("/workspace/repo").length) throw new Error("destination not empty");
      NodeFS.rmdirSync("/workspace/repo");
    }
    NodeFS.renameSync("/workspace/importing", "/workspace/repo");
  }
  if (exportId) {
    if (!/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(exportId))
      throw new Error("invalid source remote");
    const remotes = git("/workspace/repo", "remote").split("\n");
    if (remotes.includes("origin")) {
      if (git("/workspace/repo", "remote", "get-url", "origin") !== exportId)
        throw new Error("source remote mismatch");
    } else git("/workspace/repo", "remote", "add", "origin", exportId);
  }
  console.log(JSON.stringify({ base, sha256: arg, path: "/workspace/repo" }));
} else if (action === "export") {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,120}$/.test(arg ?? "") ||
    !/^[a-f0-9-]{36}$/.test(exportId ?? "")
  )
    throw new Error("invalid export");
  const cwd = "/workspace/repo",
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
  const path = `/workspace/${exportId}.bundle`;
  git(cwd, "bundle", "create", path, ref, ...checkpoints);
  console.log(JSON.stringify({ head, base, sha256: sha(path), path }));
} else throw new Error("unknown operation");
