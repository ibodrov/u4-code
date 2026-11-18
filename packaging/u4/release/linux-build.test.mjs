import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  NodeAssert.ifError(result.error);
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
NodeTest.test(
  "verifies a standalone named bundle and exact wrapper export before allowing a container",
  () => {
    const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-linux-bundle-"));
    try {
      const repo = NodePath.join(temp, "repo");
      NodeFS.mkdirSync(repo);
      const git = (args) =>
        run("git", [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-C",
          repo,
          ...args,
        ]);
      git(["init", "-q", "-b", "release-source"]);
      const relative = "packaging/u4/release";
      NodeFS.mkdirSync(NodePath.join(repo, relative), { recursive: true });
      NodeFS.cpSync(import.meta.dirname, NodePath.join(repo, relative), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(repo, ".env.example"), "INERT=example\n");
      git(["add", "-f", "."]);
      git(["commit", "-qm", "fixture"]);
      const sha = git(["rev-parse", "HEAD"]),
        tree = git(["rev-parse", "HEAD^{tree}"]);
      const bundle = NodePath.join(temp, "source.bundle");
      git(["bundle", "create", bundle, "refs/heads/release-source"]);
      const digest = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(bundle))
        .digest("hex");
      const tools = NodePath.join(temp, "tools");
      NodeFS.cpSync(NodePath.join(repo, relative), tools, { recursive: true });
      const bin = NodePath.join(temp, "bin");
      NodeFS.mkdirSync(bin);
      // This fixture never starts a container or executes source from the bundle.
      NodeFS.writeFileSync(NodePath.join(bin, "podman"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const args = [
        "--bundle",
        bundle,
        "--bundle-sha256",
        digest,
        "--source-sha",
        sha,
        "--source-tree",
        tree,
        "--version",
        "0.1.10-u4.8",
        "--output-dir",
        NodePath.join(temp, "out"),
      ];
      const invoke = (changes) => {
        NodeFS.rmSync(NodePath.join(temp, "out"), { recursive: true, force: true });
        const result = NodeChildProcess.spawnSync(
          "bash",
          [
            NodePath.join(tools, "linux-build.sh"),
            ...args.map((arg, index) => changes?.[index] ?? arg),
          ],
          { encoding: "utf8", env: { PATH: bin + ":" + process.env.PATH, HOME: temp } },
        );
        NodeAssert.ifError(result.error);
        return result;
      };
      // The fake container leaves evidence directories as a real container would.
      NodeFS.writeFileSync(
        NodePath.join(bin, "podman"),
        '#!/bin/sh\nif [ "$1" = run ]; then mkdir -p "' +
          NodePath.join(temp, "out/evidence") +
          '"; fi\nexit 0\n',
        { mode: 0o755 },
      );
      const accepted = invoke();
      NodeAssert.equal(accepted.status, 0, accepted.stderr);
      for (const changes of [{ 3: "0".repeat(64) }, { 5: "0".repeat(40) }, { 7: "0".repeat(40) }])
        NodeAssert.notEqual(invoke(changes).status, 0, "identity mismatch must refuse");
      const sourceCheck = () =>
        run(process.execPath, [NodePath.join(tools, "linux-runtime-checks.mjs"), "source", repo]);
      NodeAssert.doesNotThrow(sourceCheck, "tracked inert example allowed");
      NodeFS.writeFileSync(NodePath.join(repo, ".env.local"), "PRIVATE=overlay\n");
      NodeAssert.throws(sourceCheck, "effective root dotenv must refuse");
      NodeFS.unlinkSync(NodePath.join(repo, ".env.local"));
      NodeFS.writeFileSync(NodePath.join(repo, "next"), "second commit");
      git(["add", "next"]);
      git(["commit", "-qm", "next fixture"]);
      const tip = git(["rev-parse", "HEAD"]),
        nextTree = git(["rev-parse", "HEAD^{tree}"]);
      for (const [name, revisions] of [
        ["thin", ["refs/heads/release-source", "^" + sha]],
        ["head", ["HEAD"]],
      ]) {
        const file = NodePath.join(temp, name + ".bundle");
        git(["bundle", "create", file, ...revisions]);
        const sha256 = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(file))
          .digest("hex");
        NodeAssert.notEqual(
          invoke({ 1: file, 3: sha256, 5: tip, 7: nextTree }).status,
          0,
          name + " bundle must refuse",
        );
      }
      NodeFS.appendFileSync(NodePath.join(tools, "linux-container.sh"), "\n# injected overlay\n");
      NodeAssert.notEqual(invoke().status, 0, "wrapper mismatch must refuse");
    } finally {
      NodeFS.rmSync(temp, { recursive: true, force: true });
    }
  },
);
