#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const PRIMARY = "015D461F273E1B02B8E1A501B23FE28D2FAB39D0";
export const BASE = "2bcd001c6a953acf8084b353274176e54d7af91b";
const SELF = NodeURL.fileURLToPath(import.meta.url);
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+-u4\.\d+$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STAGES = ["reserved", "unsigned", "signed", "accepted", "finalized"];
export const REQUIRED_CHECKS = [
  "linux-static",
  "linux-native-baseline",
  "desktop-launch",
  "desktop-default-home",
  "cli-default-home-descriptor",
  "older-state",
  "future-state-preflight",
  "launcher-protocols",
  "persistence-diff",
  "android-static",
  "android-native-alignment",
  "apk-signature",
  "desktop-acceptance",
  "apk-device-acceptance",
];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function text(value, label) {
  requireThat(
    typeof value === "string" &&
      value.trim().length > 0 &&
      !/⟨|⟩|<final>|TODO|PLACEHOLDER/i.test(value),
    `missing or invalid ${label}`,
  );
  return value;
}
function regular(file) {
  requireThat(NodeFS.lstatSync(file).isFile(), `not a regular file: ${file}`);
  return file;
}
export function hashFile(file) {
  return NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(regular(file)))
    .digest("hex");
}
function syncDir(dir) {
  const fd = NodeFS.openSync(dir, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}
export function atomicJson(file, value) {
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(temp, "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(temp, file);
  syncDir(NodePath.dirname(file));
}
function run(command, args, options = {}) {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
function inputProcess(command, args, input, options = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-input-"));
  const path = NodePath.join(root, "request");
  NodeFS.writeFileSync(path, input, { mode: 0o600 });
  const fd = NodeFS.openSync(path, "r");
  const out = NodeFS.openSync(NodePath.join(root, "stdout"), "wx", 0o600);
  const err = NodeFS.openSync(NodePath.join(root, "stderr"), "wx", 0o600);
  try {
    const result = NodeChildProcess.spawnSync(command, args, {
      encoding: "utf8",
      stdio: [fd, out, err],
      ...options,
    });
    return {
      ...result,
      stdout: NodeFS.readFileSync(NodePath.join(root, "stdout"), "utf8"),
      stderr: NodeFS.readFileSync(NodePath.join(root, "stderr"), "utf8"),
    };
  } finally {
    NodeFS.closeSync(fd);
    NodeFS.closeSync(out);
    NodeFS.closeSync(err);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
function git(repo, ...args) {
  return run("git", ["-C", repo, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: NodePath.dirname(repo),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}
function identity(input) {
  requireThat(VERSION.test(input.version), "invalid U4 version");
  requireThat(
    HEX40.test(input.sourceSha) && HEX40.test(input.sourceTree),
    "invalid source identity",
  );
  requireThat(HEX64.test(input.contractHash), "invalid contract hash");
  requireThat(SAFE.test(input.runId), "invalid run identity");
  return Object.fromEntries(
    ["version", "sourceSha", "sourceTree", "contractHash", "runId"].map((key) => [key, input[key]]),
  );
}
function outputsMatch(outputs) {
  for (const output of outputs) {
    requireThat(
      NodePath.isAbsolute(output.file) && HEX64.test(output.sha256),
      "invalid immutable output",
    );
    requireThat(
      hashFile(output.file) === output.sha256,
      `immutable output changed: ${output.file}`,
    );
  }
}
function reserveUnlocked(file, input) {
  const bound = identity(input);
  requireThat(
    Number.isSafeInteger(input.installedCode) &&
      input.installedCode >= 0 &&
      input.installedCode <= 2100000000,
    "installed U4 code must be supplied (0 only if none installed)",
  );
  const record = NodeFS.existsSync(file)
    ? JSON.parse(NodeFS.readFileSync(regular(file), "utf8"))
    : { schema: "u4-reservations/1", runs: [] };
  requireThat(
    record.schema === "u4-reservations/1" && Array.isArray(record.runs),
    "invalid reservation record",
  );
  for (const prior of record.runs) {
    identity(prior);
    requireThat(
      Number.isSafeInteger(prior.testCode) &&
        Number.isSafeInteger(prior.releaseCode) &&
        prior.testCode > 0 &&
        prior.releaseCode > prior.testCode &&
        prior.releaseCode <= 2100000000 &&
        [...STAGES, "abandoned"].includes(prior.stage) &&
        Array.isArray(prior.outputs),
      "corrupt reservation history",
    );
  }
  requireThat(
    new Set(record.runs.map((prior) => prior.runId)).size === record.runs.length,
    "duplicate run identity in record",
  );
  let entry = record.runs.find((item) => item.runId === input.runId);
  if (entry) {
    for (const [key, value] of Object.entries(bound))
      requireThat(
        entry[key] === value,
        "run identity changed; abandon it and reserve higher codes under a new run ID",
      );
    requireThat(
      entry.testCode === input.testCode && entry.releaseCode === input.releaseCode,
      "code identity changed",
    );
    requireThat(entry.stage !== "abandoned", "abandoned run cannot resume");
    if (input.stage !== "abandoned") outputsMatch(entry.outputs);
    requireThat(
      input.installedCode <= entry.releaseCode,
      "installed U4 code is newer than this reservation",
    );
  } else {
    requireThat(
      !record.runs.some((item) => item.version === input.version && item.stage === "finalized"),
      "completed version cannot be reused",
    );
    requireThat(
      !record.runs.some((item) => !["abandoned", "finalized"].includes(item.stage)),
      "another run is active; explicitly abandon it first",
    );
    const maximum = Math.max(input.installedCode, ...record.runs.map((item) => item.releaseCode));
    requireThat(
      Number.isSafeInteger(input.testCode) &&
        Number.isSafeInteger(input.releaseCode) &&
        input.testCode > maximum &&
        input.releaseCode > input.testCode &&
        input.releaseCode <= 2100000000,
      "both codes must exceed prior reserved and installed codes",
    );
    requireThat(!input.stage || input.stage === "reserved", "new run must start at reserved stage");
    entry = {
      ...bound,
      testCode: input.testCode,
      releaseCode: input.releaseCode,
      stage: "reserved",
      outputs: [],
    };
    record.runs.push(entry);
  }
  const wasFinalized = entry.stage === "finalized";
  if (input.stage && input.stage !== entry.stage) {
    requireThat(
      input.stage === "abandoned" ||
        STAGES.indexOf(input.stage) === STAGES.indexOf(entry.stage) + 1,
      "invalid stage transition",
    );
    requireThat(entry.stage !== "finalized", "finalized run is immutable");
    requireThat(
      input.stage === "abandoned" || (Array.isArray(input.outputs) && input.outputs.length > 0),
      "stage requires immutable output hashes",
    );
    entry.stage = input.stage;
  }
  if (input.outputs) {
    requireThat(Array.isArray(input.outputs), "invalid outputs");
    outputsMatch(input.outputs);
    for (const output of input.outputs) {
      const prior = entry.outputs.find((item) => item.file === output.file);
      requireThat(!prior || prior.sha256 === output.sha256, "immutable output cannot be replaced");
      requireThat(!wasFinalized || prior, "finalized outputs cannot be extended");
      if (!prior) entry.outputs.push({ file: output.file, sha256: output.sha256 });
    }
  }
  atomicJson(file, record);
  return entry;
}
export function reserve(file, input) {
  requireThat(NodePath.isAbsolute(file), "reservation record must be absolute");
  const result = inputProcess(
    "flock",
    ["--exclusive", "--nonblock", `${file}.lock`, process.execPath, SELF, "_reserve", file],
    JSON.stringify(input),
    { env: { PATH: "/usr/bin:/bin" } },
  );
  requireThat(
    !result.error && result.status === 0,
    result.stderr?.trim() || "reservation lock is held or reservation failed",
  );
  return JSON.parse(result.stdout);
}

function sourceIdentity({ sourceSha, sourceTree, ref }) {
  requireThat(HEX40.test(sourceSha) && HEX40.test(sourceTree), "invalid source SHA/tree");
  requireThat(
    /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes(".."),
    "expected named source ref required",
  );
}
export function bundleSource({ repo, bundle, sourceSha, sourceTree, ref }) {
  sourceIdentity({ sourceSha, sourceTree, ref });
  requireThat(!NodeFS.existsSync(bundle), "bundle output already exists");
  requireThat(git(repo, "rev-parse", `${ref}^{commit}`) === sourceSha, "source ref tip mismatch");
  requireThat(git(repo, "rev-parse", `${ref}^{tree}`) === sourceTree, "source tree mismatch");
  const temp = `${bundle}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    git(repo, "bundle", "create", temp, ref);
    requireThat(
      git(repo, "rev-parse", `${ref}^{commit}`) === sourceSha,
      "source ref changed during bundle creation",
    );
    verifyBundle({ bundle: temp, bundleSha256: hashFile(temp), sourceSha, sourceTree, ref });
    NodeFS.renameSync(temp, bundle);
    syncDir(NodePath.dirname(bundle));
  } finally {
    NodeFS.rmSync(temp, { force: true });
  }
  return { bundleSha256: hashFile(bundle), sourceSha, sourceTree, ref };
}
export function verifyBundle(input, action = () => {}) {
  sourceIdentity(input);
  requireThat(
    HEX64.test(input.bundleSha256) && hashFile(input.bundle) === input.bundleSha256,
    "source bundle digest mismatch",
  );
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-source-"));
  try {
    const repo = NodePath.join(root, "repo");
    run("git", ["init", "--bare", "-q", repo]);
    git(repo, "bundle", "verify", NodePath.resolve(input.bundle));
    const heads = git(repo, "bundle", "list-heads", NodePath.resolve(input.bundle)).split("\n");
    requireThat(
      heads.length === 1 && heads[0] === `${input.sourceSha} ${input.ref}`,
      "bundle named ref/tip mismatch",
    );
    git(
      repo,
      "fetch",
      "--no-tags",
      NodePath.resolve(input.bundle),
      `${input.ref}:refs/heads/reviewed`,
    );
    requireThat(
      git(repo, "rev-parse", "refs/heads/reviewed^{tree}") === input.sourceTree,
      "bundle source tree mismatch",
    );
    return action(repo);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
function walk(root, prefix = "") {
  return NodeFS.readdirSync(NodePath.join(root, prefix)).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = NodeFS.lstatSync(NodePath.join(root, path));
    return stat.isDirectory() ? walk(root, path) : [path];
  });
}
function checkConfiguration(repo) {
  requireThat(
    git(repo, "status", "--porcelain", "--untracked-files=all") === "",
    "source has unreviewed overlays",
  );
  for (const path of git(repo, "ls-files").split("\n")) {
    const name = NodePath.basename(path);
    if (
      (name === ".env" || name.startsWith(".env.")) &&
      name !== ".env.example" &&
      !/^\.env\..+\.example$/.test(name)
    )
      throw new Error(`effective configuration is forbidden: ${path}`);
    requireThat(
      ![".npmrc", "local.properties", "gradle.properties.local"].includes(name) || path !== name,
      `root configuration overlay forbidden: ${path}`,
    );
  }
}
export function exportSource(input) {
  requireThat(!NodeFS.existsSync(input.output), "source export output already exists");
  return verifyBundle(input, (repo) => {
    const effective = git(repo, "ls-tree", "-r", "--name-only", input.sourceSha)
      .split("\n")
      .find(
        (path) =>
          (NodePath.basename(path) === ".env" || NodePath.basename(path).startsWith(".env.")) &&
          NodePath.basename(path) !== ".env.example" &&
          !/^\.env\..+\.example$/.test(NodePath.basename(path)),
      );
    requireThat(!effective, `effective configuration is forbidden: ${effective}`);
    if (input.wrappers) {
      const prefix = "packaging/u4/release/";
      const files = git(repo, "ls-tree", "-r", "--name-only", input.sourceSha, "--", prefix)
        .split("\n")
        .filter(Boolean);
      requireThat(files.length > 0, "reviewed source has no wrappers");
      requireThat(
        JSON.stringify(walk(input.wrappers).sort()) ===
          JSON.stringify(files.map((path) => path.slice(prefix.length)).sort()),
        "wrapper file set differs from reviewed source",
      );
      for (const path of files) {
        const expected = NodeChildProcess.execFileSync(
          "git",
          ["-C", repo, "show", `${input.sourceSha}:${path}`],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const mounted = NodePath.join(input.wrappers, path.slice(prefix.length));
        const mode = git(repo, "ls-tree", input.sourceSha, "--", path).split(" ")[0];
        requireThat(
          ["100644", "100755"].includes(mode) &&
            Boolean(NodeFS.lstatSync(regular(mounted)).mode & 0o111) === (mode === "100755") &&
            NodeFS.readFileSync(mounted).equals(expected),
          `wrapper differs from reviewed source: ${path}`,
        );
      }
    }
    run("git", ["clone", "--quiet", "--no-checkout", "--no-local", repo, input.output], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    git(input.output, "checkout", "--quiet", "--detach", input.sourceSha);
    requireThat(
      git(input.output, "rev-parse", "HEAD^{tree}") === input.sourceTree,
      "export tree mismatch",
    );
    checkConfiguration(input.output);
    return {
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
      bundleSha256: input.bundleSha256,
    };
  });
}

export function parseChecksums(value) {
  requireThat(typeof value === "string" && value.endsWith("\n"), "checksum list must end in LF");
  const entries = value
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
      requireThat(
        match &&
          match[2] !== "." &&
          match[2] !== ".." &&
          !["SHA256SUMS", "SHA256SUMS.asc"].includes(match[2]),
        "unsafe checksum entry",
      );
      return { sha256: match[1], file: match[2] };
    });
  const names = entries.map((entry) => entry.file);
  requireThat(new Set(names).size === names.length, "duplicate checksum entry");
  requireThat(
    JSON.stringify(names) === JSON.stringify([...names].sort()),
    "checksum entries must be sorted",
  );
  return entries;
}
export function checksumText(root, names) {
  return [...names]
    .sort()
    .map((name) => {
      requireThat(SAFE.test(name), "unsafe checksum name");
      return `${hashFile(NodePath.join(root, name))}  ${name}\n`;
    })
    .join("");
}
export function verifyDirectory(root, names, sums) {
  requireThat(
    NodeFS.lstatSync(root).isDirectory() && !NodeFS.lstatSync(root).isSymbolicLink(),
    "release directory must be a real directory",
  );
  requireThat(
    JSON.stringify(NodeFS.readdirSync(root).sort()) === JSON.stringify([...names].sort()),
    "release file set mismatch",
  );
  for (const name of names) regular(NodePath.join(root, name));
  if (names.includes("SHA256SUMS"))
    requireThat(
      NodeFS.readFileSync(NodePath.join(root, "SHA256SUMS"), "utf8") === sums,
      "checksum file bytes changed",
    );
  const entries = parseChecksums(sums);
  requireThat(
    entries.length ===
      names.filter((name) => !["SHA256SUMS", "SHA256SUMS.asc"].includes(name)).length,
    "checksum file set mismatch",
  );
  for (const entry of entries) {
    requireThat(names.includes(entry.file), "unexpected checksum file");
    requireThat(
      hashFile(NodePath.join(root, entry.file)) === entry.sha256,
      `hash mismatch: ${entry.file}`,
    );
  }
}
function verifySnapshot(root, snapshot) {
  const sums = Object.keys(snapshot)
    .sort()
    .map((name) => `${snapshot[name]}  ${name}\n`)
    .join("");
  requireThat(
    JSON.stringify(NodeFS.readdirSync(root).sort()) ===
      JSON.stringify(Object.keys(snapshot).sort()),
    "publication file set mismatch",
  );
  for (const [name, hash] of Object.entries(snapshot))
    requireThat(
      SAFE.test(name) && HEX64.test(hash) && hashFile(NodePath.join(root, name)) === hash,
      "publication hash conflict",
    );
  return sums;
}
export function publishDirectory(stage, final, snapshot) {
  requireThat(
    NodePath.dirname(NodePath.resolve(stage)) === NodePath.dirname(NodePath.resolve(final)),
    "stage must be a sibling of final",
  );
  requireThat(
    NodeFS.lstatSync(stage).isDirectory() && !NodeFS.lstatSync(stage).isSymbolicLink(),
    "invalid staging directory",
  );
  verifySnapshot(stage, snapshot);
  if (
    NodeFS.existsSync(final) ||
    (() => {
      try {
        NodeFS.lstatSync(final);
        return true;
      } catch {
        return false;
      }
    })()
  ) {
    requireThat(
      NodeFS.lstatSync(final).isDirectory() && !NodeFS.lstatSync(final).isSymbolicLink(),
      "final conflict",
    );
    verifySnapshot(final, snapshot);
    return "identical";
  }
  for (const name of Object.keys(snapshot)) {
    NodeFS.chmodSync(NodePath.join(stage, name), 0o444);
    const fd = NodeFS.openSync(NodePath.join(stage, name), "r");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  NodeFS.chmodSync(stage, 0o555);
  syncDir(stage);
  NodeFS.renameSync(stage, final);
  syncDir(NodePath.dirname(final));
  return "published";
}
export function primarySigner(status) {
  const lines = status.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  requireThat(
    lines.length === 1 && !/\[GNUPG:\] (BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG)/.test(status),
    "one valid VALIDSIG required",
  );
  const fields = lines[0].slice("[GNUPG:] VALIDSIG ".length).split(/\s+/);
  const primary = fields[9] || fields[0];
  requireThat(primary === PRIMARY, "OpenPGP primary fingerprint mismatch");
  return primary;
}
export function verifyGpg(root) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-verify-gpg-"));
  NodeFS.chmodSync(home, 0o700);
  const env = { PATH: "/usr/bin:/bin", HOME: home, GNUPGHOME: home, LANG: "C" };
  try {
    const key = NodeFS.readFileSync(
      regular(NodePath.join(root, "u4-release-signing-key.asc")),
      "utf8",
    );
    requireThat(
      key.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") && !/PRIVATE KEY/.test(key),
      "public key only",
    );
    run(
      "gpg",
      ["--batch", "--no-options", "--import", NodePath.join(root, "u4-release-signing-key.asc")],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const status = run(
      "gpg",
      [
        "--batch",
        "--no-options",
        "--status-fd=1",
        "--verify",
        NodePath.join(root, "SHA256SUMS.asc"),
        NodePath.join(root, "SHA256SUMS"),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return primarySigner(status);
  } finally {
    NodeChildProcess.spawnSync("gpgconf", ["--homedir", home, "--kill", "all"], {
      env,
      stdio: "ignore",
    });
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}
export function validateApkManifest(xml) {
  const result = inputProcess(
    "python3",
    [NodePath.join(NodePath.dirname(SELF), "apk-inspect.py"), "manifest"],
    xml,
  );
  requireThat(
    !result.error && result.status === 0,
    result.stderr || "Android manifest gate failed",
  );
  return JSON.parse(result.stdout);
}

export function verifyBinary(file, kind) {
  const fd = NodeFS.openSync(regular(file), "r");
  const header = Buffer.alloc(20);
  try {
    requireThat(
      NodeFS.readSync(fd, header, 0, header.length, 0) === header.length,
      "binary artifact too short",
    );
  } finally {
    NodeFS.closeSync(fd);
  }
  if (kind === "desktop")
    requireThat(
      header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
        header.readUInt16LE(18) === 62 &&
        header.subarray(8, 11).equals(Buffer.from([65, 73, 2])),
      "expected x86-64 type-2 AppImage",
    );
  else if (kind === "android")
    requireThat(
      header.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])),
      "expected APK ZIP binary",
    );
  else
    requireThat(
      kind === "cli" && header[0] === 31 && header[1] === 139,
      "expected CLI gzip binary",
    );
}
function filenames(version, cli) {
  return [
    { name: `U4-Code-${version}-x86_64.AppImage`, role: "desktop", required: true },
    { name: `U4-Code-${version}-arm64-v8a.apk`, role: "android", required: true },
    { name: "receipt.json", role: "receipt", required: true },
    { name: "release-contract.json", role: "contract", required: true },
    { name: "u4-release-signing-key.asc", role: "public-key", required: true },
    { name: "SHA256SUMS", role: "checksums", required: true },
    { name: "SHA256SUMS.asc", role: "signature", required: true },
    ...(cli ? [{ name: `t3-${version}-linux-x64.tar.gz`, role: "cli", required: false }] : []),
  ];
}
function secretScan(value) {
  requireThat(
    !/-----BEGIN (?:PGP PRIVATE|(?:RSA |EC |OPENSSH )?PRIVATE) KEY|Authorization\s*[:=]|https?:\/\/[^\s/"']+:[^\s/"']+@|(?:password|storepass|keypass|accessToken|authToken|netrc)\s*["']?\s*[:=]/i.test(
      value,
    ),
    "secret-looking metadata",
  );
}
export function validateReceipt(receipt, evidenceRoot) {
  requireThat(receipt.schema === "u4-release-receipt/1", "invalid receipt schema");
  const fields = [
    "schema",
    "version",
    "androidVersionCode",
    "source",
    "versionSubstitutions",
    "build",
    "inputs",
    "env",
    "checks",
    "artifacts",
    "apk",
    "compatibility",
    "limitations",
    "trust",
  ];
  requireThat(
    Object.keys(receipt).every((key) => fields.includes(key)),
    "unknown receipt field or secret-looking metadata",
  );
  requireThat(VERSION.test(receipt.version), "invalid receipt version");
  const source = receipt.source;
  requireThat(
    source &&
      HEX40.test(source.sha) &&
      HEX40.test(source.tree) &&
      source.baseSha === BASE &&
      HEX64.test(source.bundleSha256),
    "invalid receipt source",
  );
  requireThat(
    Array.isArray(source.sliceCommits) &&
      source.sliceCommits.length > 0 &&
      source.sliceCommits.every((sha) => HEX40.test(sha)),
    "slice commits required",
  );
  requireThat(
    Array.isArray(receipt.versionSubstitutions) && receipt.versionSubstitutions.length > 0,
    "version substitutions required",
  );
  for (const item of receipt.versionSubstitutions) {
    requireThat(
      typeof item.file === "string" &&
        /(^|\/)package\.json$/.test(item.file) &&
        !item.file.includes("..") &&
        !NodePath.isAbsolute(item.file),
      "invalid version substitution path",
    );
    text(item.from, "previous version");
    requireThat(item.to === receipt.version, "substitution version mismatch");
  }
  requireThat(receipt.env?.t3ConnectOptIn === false, "Connect must be opt-out");
  const linux = receipt.build?.linux;
  requireThat(
    linux &&
      /^sha256:[a-f0-9]{64}$/.test(linux.imageDigest) &&
      /^docker\.io\/library\/debian(?::(?:12|bookworm)[^@]*)?@sha256:[a-f0-9]{64}$/.test(
        linux.image,
      ) &&
      linux.image.endsWith(linux.imageDigest),
    "pinned Debian 12 build image required",
  );
  for (const key of ["rustc", "cargo", "glibc"]) text(linux[key], `Linux ${key}`);
  requireThat(
    linux.node === "26.13.1" && linux.pnpm === "12.14.0" && /1\.99\.1/.test(linux.rustc),
    "Linux toolchain pin mismatch",
  );
  requireThat(HEX64.test(linux.dpkgListSha256), "dpkg list digest required");
  const android = receipt.build?.android;
  requireThat(
    android &&
      android.node === "26.13.1" &&
      android.pnpm === "12.14.0" &&
      /17\.0\.14/.test(android.jdk) &&
      android.buildTools === "37.0.0" &&
      android.ndk === "27.1.12297006" &&
      android.cmake === "3.22.1",
    "Android toolchain pin mismatch",
  );
  for (const key of ["host", "agp", "gradle"]) text(android[key], `Android ${key}`);
  requireThat(
    HEX64.test(receipt.inputs?.pnpmLockSha256) &&
      HEX64.test(receipt.inputs?.nodeTarballSha256) &&
      Array.isArray(receipt.inputs?.cargoLockSha256) &&
      receipt.inputs.cargoLockSha256.length > 0 &&
      receipt.inputs.cargoLockSha256.every((hash) => HEX64.test(hash)),
    "input digests required",
  );
  requireThat(Array.isArray(receipt.checks), "completed checks required");
  const ids = new Set();
  for (const check of receipt.checks) {
    requireThat(!ids.has(check.id), "duplicate check");
    ids.add(check.id);
    requireThat(
      REQUIRED_CHECKS.includes(check.id) || check.id === "cli-archive",
      "later/self-verification or unknown receipt check",
    );
    requireThat(check.result === "passed", `check is incomplete: ${check.id}`);
    text(check.command, "check command");
    requireThat(
      HEX64.test(check.evidenceSha256) && NodePath.isAbsolute(check.evidenceFile),
      "durable evidence file and digest required",
    );
    if (evidenceRoot) {
      requireThat(
        NodeFS.realpathSync(check.evidenceFile).startsWith(`${NodeFS.realpathSync(evidenceRoot)}/`),
        "evidence outside durable evidence root",
      );
      requireThat(
        hashFile(check.evidenceFile) === check.evidenceSha256,
        "evidence digest mismatch",
      );
    }
  }
  for (const id of REQUIRED_CHECKS) requireThat(ids.has(id), `missing completed proof: ${id}`);
  const apk = receipt.apk;
  requireThat(
    apk?.package === "ca.ibodrov.u4code" &&
      apk.versionName === receipt.version &&
      Number.isSafeInteger(apk.versionCode) &&
      apk.versionCode === receipt.androidVersionCode &&
      apk.versionCode > 0 &&
      apk.versionCode <= 2100000000,
    "APK identity mismatch",
  );
  for (const key of ["unsignedSha256", "signedSha256", "certSha256"])
    requireThat(HEX64.test(apk[key]), `invalid APK ${key}`);
  requireThat(
    JSON.stringify([...apk.schemes].sort()) === JSON.stringify(["clerk", "exp+u4code", "u4code"]),
    "APK scheme mismatch",
  );
  const compatibility = receipt.compatibility;
  requireThat(
    compatibility?.orchestrationProtocol === 2 &&
      compatibility.serviceLauncherProtocol === 4 &&
      Number.isInteger(compatibility.databaseMigrationHead) &&
      compatibility.databaseMigrationHead > 0 &&
      compatibility.newerStateProbe === "blocked-without-writes" &&
      compatibility.persistenceDiffSinceU47 === "empty",
    "compatibility proof missing",
  );
  requireThat(
    Array.isArray(compatibility.testedCombinations) && compatibility.testedCombinations.length > 0,
    "exact tested combinations required",
  );
  requireThat(
    Array.isArray(receipt.limitations) && receipt.limitations.length > 0,
    "limitations required",
  );
  requireThat(
    receipt.trust ===
      "reviewed source and trusted workstation; no antirollback, offline-signing or compromised-builder protection",
    "trust claim mismatch",
  );
  const binaries = filenames(receipt.version, ids.has("cli-archive")).filter((entry) =>
    ["desktop", "android", "cli"].includes(entry.role),
  );
  requireThat(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length === binaries.length,
    "artifacts must contain binaries only",
  );
  for (const binary of binaries) {
    const artifacts = receipt.artifacts.filter(
      (artifact) => artifact.file === binary.name && artifact.kind === binary.role,
    );
    requireThat(
      artifacts.length === 1 &&
        HEX64.test(artifacts[0].sha256) &&
        Number.isSafeInteger(artifacts[0].size) &&
        artifacts[0].size > 0,
      "invalid binary artifact",
    );
    if (binary.role === "android")
      requireThat(artifacts[0].sha256 === apk.signedSha256, "APK artifact hash mismatch");
  }
  secretScan(JSON.stringify(receipt));
  return receipt;
}
export function validateAcceptance(receipt, root) {
  for (const [id, kind, checks] of [
    [
      "desktop-acceptance",
      "desktop",
      [
        "isolatedProfile",
        "packagedAppImage",
        "pairingAndBasicAction",
        "connections",
        "remoteLink",
        "sshFailClosed",
        "composerRunOn",
        "addProjectToMachine",
        "officialStatePreserved",
      ],
    ],
    [
      "apk-device-acceptance",
      "android",
      [
        "productionApk",
        "pairingAndBasicAction",
        "upgradePreservesState",
        "downgradeRejected",
        "wrongSignerRejected",
        "statePreservedAfterRejections",
        "officialStatePreserved",
        "otaDisabled",
      ],
    ],
  ]) {
    const proof = receipt.checks.find((check) => check.id === id);
    const doc = JSON.parse(NodeFS.readFileSync(proof.evidenceFile, "utf8"));
    requireThat(
      doc.sourceSha === receipt.source.sha &&
        doc.artifactSha256 === receipt.artifacts.find((artifact) => artifact.kind === kind).sha256,
      "acceptance is not bound to final source/bytes",
    );
    for (const key of checks)
      requireThat(doc.checks?.[key] === "passed", `missing acceptance proof: ${key}`);
    text(doc.client, "accepted client");
    text(doc.environment, "accepted environment");
  }
  requireThat(NodePath.isAbsolute(root), "durable evidence root required");
}
export function finalize(input) {
  const receipt = validateReceipt(
    JSON.parse(NodeFS.readFileSync(regular(input.receipt), "utf8")),
    input.evidenceRoot,
  );
  validateAcceptance(receipt, input.evidenceRoot);
  requireThat(receipt.version === "0.1.10-u4.8", "tonight's release version mismatch");
  verifyBundle(
    {
      bundle: input.bundle,
      bundleSha256: receipt.source.bundleSha256,
      sourceSha: receipt.source.sha,
      sourceTree: receipt.source.tree,
      ref: input.ref,
    },
    (repo) => {
      requireThat(
        git(repo, "merge-base", "--is-ancestor", BASE, receipt.source.sha) === "",
        "source does not descend from required parent base",
      );
      for (const commit of receipt.source.sliceCommits)
        git(repo, "merge-base", "--is-ancestor", commit, receipt.source.sha);
      const linuxConfig = JSON.parse(
        git(repo, "show", `${receipt.source.sha}:packaging/u4/release/linux-build-config.json`),
      );
      requireThat(
        linuxConfig.image.distribution === "debian" &&
          linuxConfig.image.version === "12" &&
          linuxConfig.image.architecture === "amd64" &&
          receipt.build.linux.image === linuxConfig.image.reference &&
          receipt.build.linux.imageDigest === linuxConfig.image.amd64Digest &&
          receipt.inputs.nodeTarballSha256 === linuxConfig.node.sha256,
        "Linux image or Node archive differs from reviewed source inputs",
      );
      const lock = NodeChildProcess.execFileSync(
        "git",
        ["-C", repo, "show", `${receipt.source.sha}:pnpm-lock.yaml`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      requireThat(
        NodeCrypto.createHash("sha256").update(lock).digest("hex") ===
          receipt.inputs.pnpmLockSha256,
        "source lockfile digest mismatch",
      );
      const cargoFiles = git(repo, "ls-tree", "-r", "--name-only", receipt.source.sha)
        .split("\n")
        .filter((name) => name.endsWith("Cargo.lock"));
      const cargoDigests = cargoFiles.map((file) =>
        NodeCrypto.createHash("sha256")
          .update(
            NodeChildProcess.execFileSync(
              "git",
              ["-C", repo, "show", `${receipt.source.sha}:${file}`],
              {
                stdio: ["ignore", "pipe", "pipe"],
              },
            ),
          )
          .digest("hex"),
      );
      requireThat(
        receipt.inputs.cargoLockSha256.every((hash) => cargoDigests.includes(hash)),
        "Cargo lock digest does not belong to source",
      );
      for (const substitution of receipt.versionSubstitutions)
        requireThat(
          JSON.parse(git(repo, "show", `${receipt.source.sha}:${substitution.file}`)).version ===
            substitution.from,
          "version substitution source mismatch",
        );
    },
  );
  requireThat(
    hashFile(input.reviewedContract) === input.contractHash,
    "reviewed contract digest mismatch",
  );
  requireThat(
    NodePath.isAbsolute(input.verification) &&
      !NodePath.resolve(input.verification).startsWith(`${NodePath.resolve(input.final)}/`),
    "verification evidence must be external to final payload",
  );
  const request = JSON.parse(NodeFS.readFileSync(regular(input.reservationRequest), "utf8"));
  requireThat(
    request.version === receipt.version &&
      request.sourceSha === receipt.source.sha &&
      request.sourceTree === receipt.source.tree &&
      request.contractHash === input.contractHash &&
      request.releaseCode === receipt.androidVersionCode,
    "reservation/receipt identity mismatch",
  );
  const reservation = reserve(input.record, request);
  requireThat(
    ["accepted", "finalized"].includes(reservation.stage),
    "reservation lacks completed acceptance",
  );
  const cli = receipt.artifacts.some((entry) => entry.kind === "cli");
  const files = filenames(receipt.version, cli);
  const names = files.map((entry) => entry.name);
  const stage = NodePath.join(
    NodePath.dirname(NodePath.resolve(input.final)),
    `.u4-stage-${NodeCrypto.randomUUID()}`,
  );
  NodeFS.mkdirSync(stage, { mode: 0o700 });
  const contract = {
    schema: "u4-release-contract/1",
    version: receipt.version,
    baseUrl: `https://u4.ibodrov.ca/releases/${receipt.version}/`,
    source: { sha: receipt.source.sha, tree: receipt.source.tree },
    signing: { openpgpFingerprint: PRIMARY },
    android: {
      package: "ca.ibodrov.u4code",
      versionCode: receipt.androidVersionCode,
      abi: "arm64-v8a",
    },
    files,
    checksums: { file: "SHA256SUMS", covers: "all files except SHA256SUMS and SHA256SUMS.asc" },
  };
  if (NodeFS.existsSync(input.final)) {
    requireThat(
      JSON.stringify(
        JSON.parse(
          NodeFS.readFileSync(regular(NodePath.join(input.final, "receipt.json")), "utf8"),
        ),
      ) === JSON.stringify(receipt) &&
        JSON.stringify(
          JSON.parse(
            NodeFS.readFileSync(
              regular(NodePath.join(input.final, "release-contract.json")),
              "utf8",
            ),
          ),
        ) === JSON.stringify(contract),
      "final replay conflicts with frozen metadata",
    );
    const sums = NodeFS.readFileSync(regular(NodePath.join(input.final, "SHA256SUMS")), "utf8");
    verifyDirectory(input.final, names, sums);
    verifyGpg(input.final);
    for (const artifact of receipt.artifacts)
      requireThat(
        hashFile(NodePath.join(input.final, artifact.file)) === artifact.sha256 &&
          NodeFS.lstatSync(NodePath.join(input.final, artifact.file)).size === artifact.size,
        "final replay binary conflict",
      );
    const snapshot = Object.fromEntries(
      names.map((name) => [name, hashFile(NodePath.join(input.final, name))]),
    );
    reserve(input.record, {
      ...request,
      stage: "finalized",
      outputs: names.map((name) => ({
        file: NodePath.resolve(input.final, name),
        sha256: snapshot[name],
      })),
    });
    NodeFS.rmSync(stage);
    const evidence = {
      schema: "u4-final-verification/1",
      result: "identical",
      sourceSha: receipt.source.sha,
      digests: snapshot,
      primaryFingerprint: PRIMARY,
      downloadVerification: "pending-external",
    };
    atomicJson(input.verification, evidence);
    return evidence;
  }
  for (const artifact of receipt.artifacts) {
    const path = NodePath.join(input.binaries, artifact.file);
    verifyBinary(path, artifact.kind);
    requireThat(
      hashFile(path) === artifact.sha256 && NodeFS.lstatSync(path).size === artifact.size,
      "binary bytes differ from accepted receipt",
    );
    NodeFS.copyFileSync(path, NodePath.join(stage, artifact.file));
    requireThat(
      hashFile(NodePath.join(stage, artifact.file)) === artifact.sha256 &&
        NodeFS.lstatSync(NodePath.join(stage, artifact.file)).size === artifact.size,
      "binary changed while staging",
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(stage, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(stage, "release-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  const publicKey = run(
    "gpg",
    ["--no-options", "--armor", "--export-options", "export-minimal", "--export", PRIMARY],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  requireThat(
    publicKey.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") && !/PRIVATE KEY/.test(publicKey),
    "missing approved public key",
  );
  NodeFS.writeFileSync(NodePath.join(stage, "u4-release-signing-key.asc"), publicKey);
  const payload = names.filter((name) => !["SHA256SUMS", "SHA256SUMS.asc"].includes(name));
  const sums = checksumText(stage, payload);
  NodeFS.writeFileSync(NodePath.join(stage, "SHA256SUMS"), sums);
  for (const name of [...payload, "SHA256SUMS"])
    NodeFS.chmodSync(NodePath.join(stage, name), 0o444);
  run(
    "gpg",
    [
      "--no-options",
      "--local-user",
      PRIMARY,
      "--armor",
      "--detach-sign",
      "--output",
      NodePath.join(stage, "SHA256SUMS.asc"),
      NodePath.join(stage, "SHA256SUMS"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  verifyDirectory(stage, names, sums);
  verifyGpg(stage);
  const snapshot = Object.fromEntries(
    names.map((name) => [name, hashFile(NodePath.join(stage, name))]),
  );
  // Serialize final rename and replay checks without keeping a crash-stale userspace lock.
  const result = inputProcess(
    "flock",
    ["--exclusive", "--nonblock", `${input.final}.lock`, process.execPath, SELF, "_publish"],
    JSON.stringify({ stage, final: input.final, snapshot }),
    { env: { PATH: "/usr/bin:/bin" } },
  );
  requireThat(
    !result.error && result.status === 0,
    result.stderr || "final publication lock failed",
  );
  const published = JSON.parse(result.stdout);
  if (published === "identical") {
    NodeFS.chmodSync(stage, 0o700);
    NodeFS.rmSync(stage, { recursive: true });
  }
  const frozen = names.map((name) => ({
    file: NodePath.resolve(input.final, name),
    sha256: snapshot[name],
  }));
  reserve(input.record, { ...request, stage: "finalized", outputs: frozen });
  const evidence = {
    schema: "u4-final-verification/1",
    result: published,
    sourceSha: receipt.source.sha,
    digests: snapshot,
    primaryFingerprint: PRIMARY,
    stage: "verified-before-atomic-rename",
    acceptance: "prepublication-complete",
    downloadVerification: "pending-external",
  };
  atomicJson(input.verification, evidence);
  return evidence;
}

function flags(args) {
  const output = {};
  requireThat(args.length % 2 === 0, "expected --flag value pairs");
  for (let i = 0; i < args.length; i += 2) {
    requireThat(/^--[a-z][a-z0-9-]*$/.test(args[i]), "invalid flag");
    const key = args[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    requireThat(!(key in output), "duplicate flag");
    output[key] = args[i + 1];
  }
  return output;
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "_reserve")
    return reserveUnlocked(args[0], JSON.parse(NodeFS.readFileSync(0, "utf8")));
  if (command === "_publish") {
    const input = JSON.parse(NodeFS.readFileSync(0, "utf8"));
    return publishDirectory(input.stage, input.final, input.snapshot);
  }
  const input = flags(args);
  switch (command) {
    case "bundle":
      return bundleSource(input);
    case "export":
      return exportSource(input);
    case "reserve":
      return reserve(
        input.record,
        JSON.parse(input.request ?? NodeFS.readFileSync(regular(input.requestFile), "utf8")),
      );
    case "finalize":
      return finalize(input);
    case "verify": {
      const contract = JSON.parse(
        NodeFS.readFileSync(regular(NodePath.join(input.dir, "release-contract.json")), "utf8"),
      );
      const receipt = validateReceipt(
        JSON.parse(NodeFS.readFileSync(regular(NodePath.join(input.dir, "receipt.json")), "utf8")),
      );
      requireThat(
        contract.version === "0.1.10-u4.8" &&
          contract.version === receipt.version &&
          contract.source.sha === receipt.source.sha &&
          contract.source.tree === receipt.source.tree &&
          contract.android.package === receipt.apk.package &&
          contract.android.versionCode === receipt.androidVersionCode &&
          contract.signing.openpgpFingerprint === PRIMARY,
        "download contract identity mismatch",
      );
      const expected = filenames(
        receipt.version,
        receipt.artifacts.some((artifact) => artifact.kind === "cli"),
      );
      requireThat(
        JSON.stringify(contract.files) === JSON.stringify(expected),
        "contract file list mismatch",
      );
      const sums = NodeFS.readFileSync(regular(NodePath.join(input.dir, "SHA256SUMS")), "utf8");
      verifyDirectory(
        input.dir,
        expected.map((file) => file.name),
        sums,
      );
      for (const artifact of receipt.artifacts) {
        verifyBinary(NodePath.join(input.dir, artifact.file), artifact.kind);
        requireThat(
          hashFile(NodePath.join(input.dir, artifact.file)) === artifact.sha256 &&
            NodeFS.lstatSync(NodePath.join(input.dir, artifact.file)).size === artifact.size,
          "download binary mismatch",
        );
      }
      verifyGpg(input.dir);
      return {
        verified: true,
        primaryFingerprint: PRIMARY,
        contractSha256: hashFile(NodePath.join(input.dir, "release-contract.json")),
        checksumsSha256: hashFile(NodePath.join(input.dir, "SHA256SUMS")),
        signatureSha256: hashFile(NodePath.join(input.dir, "SHA256SUMS.asc")),
      };
    }
    default:
      throw new Error("usage: finalize.mjs bundle|export|reserve|finalize|verify --flag value ...");
  }
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === SELF) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
