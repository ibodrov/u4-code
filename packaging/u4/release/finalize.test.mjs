import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  atomicJson,
  REQUIRED_CHECKS,
  BASE,
  bundleSource,
  checksumText,
  exportSource,
  hashFile,
  parseChecksums,
  primarySigner,
  publishDirectory,
  reserve,
  validateApkManifest,
  validateReceipt,
  validateAcceptance,
  verifyBinary,
  verifyDirectory,
} from "./finalize.mjs";

const test = process.env.VITEST ? (await import("vite-plus/test")).test : NodeTest.test;

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const digest = "c".repeat(64);
const identity = {
  version: "0.1.10-u4.8",
  sourceSha: sha,
  sourceTree: tree,
  contractHash: digest,
  runId: "fixture-1",
};

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-wr-test-"));
  (t.after ?? t.onTestFinished).call(t, () => {
    const writable = (dir) => {
      NodeFS.chmodSync(dir, 0o700);
      for (const name of NodeFS.readdirSync(dir))
        if (NodeFS.lstatSync(NodePath.join(dir, name)).isDirectory())
          writable(NodePath.join(dir, name));
    };
    if (NodeFS.existsSync(root)) writable(root);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("reservation is durable across restart, binds identities and burns abandoned pairs", (t) => {
  const root = fixture(t);
  const file = NodePath.join(root, "reservations.json");
  const request = {
    ...identity,
    installedCode: 2026111499,
    testCode: 2026111500,
    releaseCode: 2026111501,
  };
  const first = reserve(file, request);
  NodeAssert.equal(first.stage, "reserved");
  NodeAssert.deepEqual(reserve(file, request), first);
  NodeAssert.throws(() => reserve(file, { ...request, sourceSha: "d".repeat(40) }), /identity/);
  NodeAssert.throws(() => reserve(file, { ...request, runId: "other" }), /active/);
  const output = NodePath.join(root, "unsigned.apk");
  NodeFS.writeFileSync(output, "unsigned fixture");
  const outputs = [{ file: output, sha256: hashFile(output) }];
  const frozen = reserve(file, { ...request, stage: "unsigned", outputs });
  NodeAssert.equal(frozen.stage, "unsigned");
  NodeAssert.equal(reserve(file, request).stage, "unsigned");
  NodeFS.writeFileSync(output, "mutated");
  NodeAssert.throws(() => reserve(file, request), /immutable/);
  NodeFS.writeFileSync(output, "unsigned fixture");
  reserve(file, { ...request, stage: "abandoned" });
  NodeAssert.throws(() => reserve(file, { ...request, runId: "fixture-2" }), /exceed/);
  const second = reserve(file, {
    ...request,
    runId: "fixture-2",
    sourceSha: "d".repeat(40),
    testCode: 2026111502,
    releaseCode: 2026111503,
  });
  NodeAssert.equal(second.testCode, 2026111502);
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file)).runs.length, 2);
});

test("reservation interrupted writes and lock conflicts never release a reserved pair", (t) => {
  const root = fixture(t);
  const file = NodePath.join(root, "reservations.json");
  atomicJson(file, { schema: "u4-reservations/1", runs: [] });
  NodeFS.writeFileSync(`${file}.interrupted`, "partial");
  const request = { ...identity, installedCode: 0, testCode: 10, releaseCode: 11 };
  reserve(file, request);
  const stdout = NodePath.join(root, "response");
  const fd = NodeFS.openSync(stdout, "wx");
  const response = NodeChildProcess.spawnSync(
    process.execPath,
    [
      new URL("./finalize.mjs", import.meta.url).pathname,
      "reserve",
      "--record",
      file,
      "--request",
      JSON.stringify(request),
    ],
    { encoding: "utf8", stdio: ["ignore", fd, "pipe"] },
  );
  NodeFS.closeSync(fd);
  NodeAssert.equal(response.status, 0, response.stderr);
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(stdout, "utf8")).releaseCode, 11);
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file)).runs.length, 1);
  const lock = NodeFS.openSync(`${file}.lock`, "r");
  try {
    const locked = NodeChildProcess.spawnSync("flock", ["--exclusive", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
    });
    NodeAssert.equal(locked.status, 0);
    NodeAssert.throws(() => reserve(file, request), /lock/);
  } finally {
    NodeFS.closeSync(lock);
  }
  NodeAssert.throws(() => reserve(file, { ...request, stage: "signed" }), /stage/);
  const artifact = NodePath.join(root, "artifact.apk");
  NodeFS.writeFileSync(artifact, "frozen artifact");
  const outputs = [{ file: artifact, sha256: hashFile(artifact) }];
  for (const stage of ["unsigned", "signed", "accepted", "finalized"]) {
    NodeAssert.equal(reserve(file, { ...request, stage, outputs }).stage, stage);
    NodeAssert.equal(reserve(file, request).stage, stage);
  }
  NodeAssert.throws(
    () => reserve(file, { ...request, runId: "completed-reuse", testCode: 12, releaseCode: 13 }),
    /completed/,
  );
  const addition = NodePath.join(root, "addition");
  NodeFS.writeFileSync(addition, "extra");
  NodeAssert.throws(
    () => reserve(file, { ...request, outputs: [{ file: addition, sha256: hashFile(addition) }] }),
    /extended/,
  );
  NodeFS.writeFileSync(artifact, "changed after signing");
  NodeAssert.throws(() => reserve(file, request), /immutable/);
});

test("checksums reject traversal, duplicate, extra, missing, linked and mutated files", (t) => {
  const root = fixture(t);
  NodeFS.writeFileSync(NodePath.join(root, "receipt.json"), "{}\n");
  const sums = checksumText(root, ["receipt.json"]);
  NodeAssert.equal(parseChecksums(sums).length, 1);
  for (const text of [
    sums + sums,
    sums.replace("receipt.json", "../receipt.json"),
    sums.replace("receipt.json", "/receipt.json"),
    sums.replace("receipt.json", "bad name"),
    sums.trimEnd(),
  ]) {
    NodeAssert.throws(() => parseChecksums(text));
  }
  verifyDirectory(root, ["receipt.json"], sums);
  NodeFS.writeFileSync(NodePath.join(root, "SHA256SUMS"), sums);
  verifyDirectory(root, ["receipt.json", "SHA256SUMS"], sums);
  NodeFS.writeFileSync(NodePath.join(root, "SHA256SUMS"), sums + sums);
  NodeAssert.throws(
    () => verifyDirectory(root, ["receipt.json", "SHA256SUMS"], sums),
    /bytes changed/,
  );
  NodeFS.rmSync(NodePath.join(root, "SHA256SUMS"));
  NodeFS.writeFileSync(NodePath.join(root, "extra"), "x");
  NodeAssert.throws(() => verifyDirectory(root, ["receipt.json"], sums), /file set/);
  NodeFS.rmSync(NodePath.join(root, "extra"));
  NodeFS.writeFileSync(NodePath.join(root, "receipt.json"), "changed");
  NodeAssert.throws(() => verifyDirectory(root, ["receipt.json"], sums), /hash/);
  NodeFS.rmSync(NodePath.join(root, "receipt.json"));
  NodeFS.symlinkSync("missing", NodePath.join(root, "receipt.json"));
  NodeAssert.throws(() => verifyDirectory(root, ["receipt.json"], sums), /regular/);
  NodeFS.rmSync(NodePath.join(root, "receipt.json"));
  NodeAssert.throws(() => verifyDirectory(root, ["receipt.json"], sums), /file set/);
  NodeChildProcess.execFileSync("mkfifo", [NodePath.join(root, "receipt.json")], {
    stdio: "ignore",
  });
  NodeAssert.throws(() => verifyDirectory(root, ["receipt.json"], sums), /regular/);
});

test("atomic publication accepts identical replay and refuses conflicting or partial final", (t) => {
  const root = fixture(t);
  const final = NodePath.join(root, "final");
  const stage = NodePath.join(root, "stage");
  NodeFS.mkdirSync(stage);
  NodeFS.writeFileSync(NodePath.join(stage, "a"), "complete");
  const snapshot = { a: hashFile(NodePath.join(stage, "a")) };
  NodeAssert.throws(() => publishDirectory(stage, final, { a: digest }), /hash/);
  NodeAssert.equal(NodeFS.existsSync(final), false);
  NodeAssert.equal(publishDirectory(stage, final, snapshot), "published");
  NodeFS.mkdirSync(stage);
  NodeFS.writeFileSync(NodePath.join(stage, "a"), "complete");
  NodeAssert.equal(publishDirectory(stage, final, snapshot), "identical");
  NodeAssert.throws(() => publishDirectory(stage, final, { a: digest }), /conflict|hash/);
  NodeFS.writeFileSync(NodePath.join(stage, "extra"), "partial");
  NodeAssert.throws(() => publishDirectory(stage, final, snapshot), /file set/);
});

test("GPG primary identity accepts a bound signing subkey and refuses another primary", () => {
  const primary = "015D461F273E1B02B8E1A501B23FE28D2FAB39D0";
  NodeAssert.equal(
    primarySigner(`[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-11-15 0 0 4 0 1 10 00 ${primary}\n`),
    primary,
  );
  NodeAssert.throws(
    () =>
      primarySigner(
        `[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-11-15 0 0 4 0 1 10 00 ${"B".repeat(40)}\n`,
      ),
    /fingerprint/,
  );
  NodeAssert.throws(() => primarySigner("[GNUPG:] GOODSIG not-enough\n"), /VALIDSIG/);
});

test("named-ref bundle is self-contained and rejects wrong digest, tip, tree and wrapper overlay", (t) => {
  const root = fixture(t);
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  NodeFS.mkdirSync(NodePath.join(repo, "packaging/u4/release"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, ".env.example"), "INERT=true\n");
  NodeFS.mkdirSync(NodePath.join(repo, ".repos/effect"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, ".repos/effect/.envrc"), "use flake\n");
  NodeFS.writeFileSync(NodePath.join(repo, "packaging/u4/release/tool"), "reviewed wrapper\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const sourceSha = git("rev-parse", "HEAD");
  const sourceTree = git("rev-parse", "HEAD^{tree}");
  const ref = "refs/heads/reviewed";
  git("update-ref", ref, sourceSha);
  const bundle = NodePath.join(root, "src.bundle");
  const expected = { bundle, sourceSha, sourceTree, ref };
  bundleSource({ ...expected, repo });
  const bundleSha256 = hashFile(bundle);
  exportSource({
    ...expected,
    bundleSha256,
    output: NodePath.join(root, "export"),
    wrappers: NodePath.join(repo, "packaging/u4/release"),
  });
  const cliOut = NodePath.join(root, "cli-export-result");
  const cliError = NodePath.join(root, "cli-export-error");
  const stdout = NodeFS.openSync(cliOut, "wx");
  const stderr = NodeFS.openSync(cliError, "wx");
  let cli;
  try {
    cli = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "finalize.mjs"),
        "export",
        "--bundle",
        bundle,
        "--bundle-sha256",
        bundleSha256,
        "--source-sha",
        sourceSha,
        "--source-tree",
        sourceTree,
        "--ref",
        ref,
        "--wrappers",
        NodePath.join(repo, "packaging/u4/release"),
        "--output",
        NodePath.join(root, "cli-export"),
      ],
      { stdio: ["ignore", stdout, stderr] },
    );
  } finally {
    NodeFS.closeSync(stdout);
    NodeFS.closeSync(stderr);
  }
  NodeAssert.ifError(cli.error);
  NodeAssert.equal(cli.status, 0, NodeFS.readFileSync(cliError, "utf8"));
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(cliOut, "utf8")).sourceSha, sourceSha);
  for (const override of [{ bundleSha256: digest }, { sourceSha: sha }, { sourceTree: tree }]) {
    NodeAssert.throws(() =>
      exportSource({ ...expected, bundleSha256, ...override, output: NodePath.join(root, "bad") }),
    );
  }
  NodeFS.writeFileSync(NodePath.join(repo, "packaging/u4/release/tool"), "unreviewed wrapper");
  NodeAssert.throws(
    () =>
      exportSource({
        ...expected,
        bundleSha256,
        output: NodePath.join(root, "overlay"),
        wrappers: NodePath.join(repo, "packaging/u4/release"),
      }),
    /wrapper/,
  );
  NodeFS.writeFileSync(NodePath.join(repo, "second-file"), "second commit");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "second fixture");
  const secondSha = git("rev-parse", "HEAD");
  git("update-ref", ref, secondSha);
  const partial = NodePath.join(root, "partial.bundle");
  git("bundle", "create", partial, ref, `^${sourceSha}`);
  NodeAssert.throws(() =>
    exportSource({
      bundle: partial,
      bundleSha256: hashFile(partial),
      sourceSha: secondSha,
      sourceTree: git("rev-parse", "HEAD^{tree}"),
      ref,
      output: NodePath.join(root, "partial"),
    }),
  );
  NodeFS.writeFileSync(NodePath.join(repo, ".env.local"), "EFFECTIVE=true");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "effective config");
  const next = git("rev-parse", "HEAD");
  const nextTree = git("rev-parse", "HEAD^{tree}");
  git("update-ref", ref, next);
  const second = NodePath.join(root, "second.bundle");
  bundleSource({ bundle: second, repo, sourceSha: next, sourceTree: nextTree, ref });
  NodeAssert.throws(
    () =>
      exportSource({
        bundle: second,
        bundleSha256: hashFile(second),
        sourceSha: next,
        sourceTree: nextTree,
        ref,
        output: NodePath.join(root, "effective"),
      }),
    /configuration/,
  );
});

test("receipt requires completed evidence and forbids temporal self-verification", () => {
  NodeAssert.throws(() => validateReceipt({ version: identity.version }), /schema/);
  NodeAssert.throws(
    () =>
      validateReceipt({
        schema: "u4-release-receipt/1",
        checks: [{ id: "download-signature", result: "passed" }],
      }),
    /schema|version|later|source/,
  );
});

test("manifest gate restricts VIEW handlers rather than outbound queries", () => {
  const good = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ca.ibodrov.u4code">
    <queries><intent><action android:name="android.intent.action.VIEW"/><data android:scheme="https"/></intent></queries>
    <application>
      <meta-data android:name="expo.modules.updates.ENABLED" android:value="false"/>
      <activity android:name="ca.ibodrov.u4code.MainActivity">
        <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="u4code"/><data android:scheme="exp+u4code"/></intent-filter>
        <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.hosted-callback"/></intent-filter>
      </activity>
      <activity android:name="com.clerk.api.sso.SSOReceiverActivity">
        <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.callback"/></intent-filter>
        <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.oauth"/></intent-filter>
      </activity>
    </application>
  </manifest>`;
  validateApkManifest(good);
  for (const bad of [
    good.replace('scheme="u4code"', 'scheme="u4code-evil"'),
    good.replace("ca.ibodrov.u4code.hosted-callback", "other.host"),
    good.replace('android:value="false"', 'android:value="true"'),
  ])
    NodeAssert.throws(() => validateApkManifest(bad));
});

function validReceipt(root) {
  const proof = NodePath.join(root, "proof.json");
  NodeFS.writeFileSync(proof, '{"fixture":true}\n');
  return {
    schema: "u4-release-receipt/1",
    version: identity.version,
    androidVersionCode: 11,
    source: { sha, tree, baseSha: BASE, bundleSha256: digest, sliceCommits: [sha] },
    versionSubstitutions: [{ file: "package.json", from: "0.1.9", to: identity.version }],
    build: {
      linux: {
        image: `docker.io/library/debian:12@sha256:${digest}`,
        imageDigest: `sha256:${digest}`,
        node: "26.13.1",
        pnpm: "12.14.0",
        rustc: "rustc 1.99.1",
        cargo: "cargo 1.99.1",
        glibc: "2.36",
        dpkgListSha256: digest,
      },
      android: {
        host: "synthetic fixture",
        node: "26.13.1",
        pnpm: "12.14.0",
        jdk: "17.0.14-tem",
        buildTools: "37.0.0",
        ndk: "27.1.12297006",
        cmake: "3.22.1",
        agp: "9.2.1",
        gradle: "9.4.1",
      },
    },
    inputs: { pnpmLockSha256: digest, cargoLockSha256: [digest], nodeTarballSha256: digest },
    env: { t3ConnectOptIn: false },
    checks: REQUIRED_CHECKS.map((id) => ({
      id,
      command: "synthetic fixture only",
      result: "passed",
      evidenceFile: proof,
      evidenceSha256: hashFile(proof),
    })),
    artifacts: [
      {
        file: `U4-Code-${identity.version}-x86_64.AppImage`,
        kind: "desktop",
        sha256: digest,
        size: 1,
      },
      {
        file: `U4-Code-${identity.version}-arm64-v8a.apk`,
        kind: "android",
        sha256: digest,
        size: 1,
      },
    ],
    apk: {
      package: "ca.ibodrov.u4code",
      versionCode: 11,
      versionName: identity.version,
      unsignedSha256: digest,
      signedSha256: digest,
      certSha256: digest,
      schemes: ["u4code", "exp+u4code", "clerk"],
    },
    compatibility: {
      orchestrationProtocol: 2,
      serviceLauncherProtocol: 4,
      databaseMigrationHead: 1,
      newerStateProbe: "blocked-without-writes",
      persistenceDiffSinceU47: "empty",
      testedCombinations: ["synthetic fixture only"],
    },
    limitations: ["synthetic fixture only"],
    trust:
      "reviewed source and trusted workstation; no antirollback, offline-signing or compromised-builder protection",
  };
}

test("receipt rejects incomplete acceptance, wrong source/version, self-verification, metadata artifacts, secrets and mutated durable proof", (t) => {
  const root = fixture(t);
  const valid = validReceipt(root);
  validateReceipt(valid, root);
  const digestOnly = structuredClone(valid);
  digestOnly.build.linux.image = `docker.io/library/debian@sha256:${digest}`;
  validateReceipt(digestOnly, root);
  const mutations = [
    (doc) => doc.checks.pop(),
    (doc) => doc.checks.push({ ...doc.checks[0], id: "download-signature" }),
    (doc) => {
      doc.checks[0].result = "pending";
    },
    (doc) => {
      doc.apk.versionName = "0.1.10-u4.7";
    },
    (doc) => {
      doc.source.sha = "bad";
    },
    (doc) => {
      doc.apk.schemes.push("https");
    },
    (doc) => {
      doc.artifacts[0].file = "../escape";
    },
    (doc) => {
      doc.artifacts[0].file = "receipt.json";
    },
    (doc) => {
      doc.build.linux.image = `docker.io/library/ubuntu:24.04@sha256:${digest}`;
    },
    (doc) => {
      doc.password = "inert forbidden fixture";
    },
    (doc) => {
      doc.limitations = ["-----BEGIN PGP PRIVATE KEY BLOCK-----"];
    },
  ];
  for (const mutate of mutations) {
    const doc = structuredClone(valid);
    mutate(doc);
    NodeAssert.throws(() => validateReceipt(doc, root));
  }
  NodeFS.writeFileSync(NodePath.join(root, "proof.json"), "mutated");
  NodeAssert.throws(() => validateReceipt(valid, root), /evidence digest/);
});

test("final acceptance requires both exact binaries and complete client outcomes", (t) => {
  const root = fixture(t);
  const receipt = validReceipt(root);
  NodeAssert.throws(() => validateAcceptance(receipt, root), /acceptance/);
  for (const id of ["desktop-acceptance", "apk-device-acceptance"]) {
    const file = NodePath.join(root, `${id}.json`);
    const check = receipt.checks.find((item) => item.id === id);
    const keys =
      id === "desktop-acceptance"
        ? [
            "isolatedProfile",
            "packagedAppImage",
            "pairingAndBasicAction",
            "connections",
            "remoteLink",
            "sshFailClosed",
            "composerRunOn",
            "addProjectToMachine",
            "officialStatePreserved",
          ]
        : [
            "productionApk",
            "pairingAndBasicAction",
            "upgradePreservesState",
            "downgradeRejected",
            "wrongSignerRejected",
            "statePreservedAfterRejections",
            "officialStatePreserved",
            "otaDisabled",
          ];
    const proof = {
      sourceSha: sha,
      artifactSha256: digest,
      client: "synthetic fixture only",
      environment: "synthetic fixture only",
      checks: Object.fromEntries(keys.map((key) => [key, "passed"])),
    };
    NodeFS.writeFileSync(file, JSON.stringify(proof));
    check.evidenceFile = file;
    check.evidenceSha256 = hashFile(file);
  }
  validateReceipt(receipt, root);
  validateAcceptance(receipt, root);
  const check = receipt.checks.find((item) => item.id === "apk-device-acceptance");
  const proof = JSON.parse(NodeFS.readFileSync(check.evidenceFile, "utf8"));
  proof.checks.statePreservedAfterRejections = "pending";
  NodeFS.writeFileSync(check.evidenceFile, JSON.stringify(proof));
  NodeAssert.throws(() => validateAcceptance(receipt, root), /statePreserved/);
  proof.checks.statePreservedAfterRejections = "passed";
  proof.artifactSha256 = "d".repeat(64);
  NodeFS.writeFileSync(check.evidenceFile, JSON.stringify(proof));
  NodeAssert.throws(() => validateAcceptance(receipt, root), /final source\/bytes/);
});

test("mislabeled plaintext or private material cannot stand in for a binary", (t) => {
  const root = fixture(t);
  const file = NodePath.join(root, "candidate.apk");
  NodeFS.writeFileSync(file, "-----BEGIN PRIVATE KEY-----\nsynthetic forbidden fixture");
  for (const kind of ["android", "desktop", "cli"])
    NodeAssert.throws(() => verifyBinary(file, kind));
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.set([65, 73, 2], 8);
  bytes.writeUInt16LE(62, 18);
  NodeFS.writeFileSync(file, bytes);
  verifyBinary(file, "desktop");
  bytes.writeUInt16LE(183, 18);
  NodeFS.writeFileSync(file, bytes);
  NodeAssert.throws(() => verifyBinary(file, "desktop"));
});
