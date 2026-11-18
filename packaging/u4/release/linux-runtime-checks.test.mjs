import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import {
  assertPreflightUnchanged,
  snapshotDatabase,
  selectGlibcNativeFiles,
  validateArchiveEntries,
  validatePreflight,
  validateVersionChanges,
} from "./linux-runtime-checks.mjs";

NodeTest.test(
  "rejects traversal, absolute paths, alternate roots before archive extraction",
  () => {
    const root = "t3-0.1.10-u4.8-linux-x64";
    NodeAssert.doesNotThrow(() =>
      validateArchiveEntries([`${root}/`, `${root}/t3`, `${root}/lib/libatomic.so.1`], root),
    );
    for (const bad of ["/etc/passwd", `${root}/../escape`, "other/file", `${root}/a/../../b`]) {
      NodeAssert.throws(() => validateArchiveEntries([bad], root));
    }
  },
);

NodeTest.test("requires the exact version-only changes across both artifact builds", () => {
  const base = { "apps/server/package.json": { version: "old", name: "t3" } };
  NodeAssert.doesNotThrow(() =>
    validateVersionChanges(
      base,
      { "apps/server/package.json": { version: "0.1.10-u4.8", name: "t3" } },
      "0.1.10-u4.8",
    ),
  );
  NodeAssert.throws(() =>
    validateVersionChanges(
      base,
      { "apps/server/package.json": { version: "0.1.10-u4.8", name: "different" } },
      "0.1.10-u4.8",
    ),
  );
});

NodeTest.test(
  "parses packaged preflight JSON and requires future refusal and exact protocol echo",
  () => {
    NodeAssert.deepEqual(
      validatePreflight('{"status":"blocked","version":"v","reason":"future 999"}', "v", 4, true),
      { status: "blocked", version: "v", reason: "future 999" },
    );
    for (const result of [
      "{}",
      '{"status":"ready","version":"v","launcherProtocol":3}',
      "not JSON",
    ]) {
      NodeAssert.throws(() => validatePreflight(result, "v", 4, false));
    }
    NodeAssert.throws(() =>
      validatePreflight('{"status":"ready","version":"v","launcherProtocol":4}', "v", 4, true),
    );
  },
);

NodeTest.test(
  "read-only WAL preflight permits only empty SQLite sidecars and unchanged bytes",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-wal-preflight-"));
    try {
      const database = NodePath.join(root, "statev2.sqlite");
      const writer = new NodeSqlite.DatabaseSync(database);
      writer.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('retained')",
      );
      writer.close();
      const beforeFiles = NodeFS.readdirSync(root).sort();
      const beforeHash = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(database))
        .digest("hex");
      const reader = new NodeSqlite.DatabaseSync(database, { readOnly: true });
      NodeAssert.equal(reader.prepare("SELECT value FROM proof").get().value, "retained");
      reader.close();
      NodeAssert.ok(NodeFS.existsSync(database + "-shm"));
      NodeAssert.ok(NodeFS.existsSync(database + "-wal"));
      NodeAssert.doesNotThrow(() => assertPreflightUnchanged(database, beforeFiles, beforeHash));
      NodeFS.writeFileSync(NodePath.join(root, "unexpected"), "unexpected");
      NodeAssert.throws(() => assertPreflightUnchanged(database, beforeFiles, beforeHash));
      NodeFS.unlinkSync(NodePath.join(root, "unexpected"));
      NodeFS.writeFileSync(database + "-wal", "nonempty");
      NodeAssert.throws(() => assertPreflightUnchanged(database, beforeFiles, beforeHash), /WAL/);
      NodeFS.truncateSync(database + "-wal", 0);
      NodeFS.appendFileSync(database, "changed");
      NodeAssert.throws(() => assertPreflightUnchanged(database, beforeFiles, beforeHash));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("evidence snapshot includes committed frames still in the source WAL", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-wal-snapshot-"));
  const writer = new NodeSqlite.DatabaseSync(NodePath.join(root, "source.sqlite"));
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('from-wal')",
    );
    NodeAssert.ok(NodeFS.statSync(NodePath.join(root, "source.sqlite-wal")).size > 0);
    const target = NodePath.join(root, "snapshot.sqlite");
    await snapshotDatabase(NodePath.join(root, "source.sqlite"), target);
    const reader = new NodeSqlite.DatabaseSync(target, { readOnly: true });
    try {
      NodeAssert.equal(reader.prepare("SELECT value FROM proof").get().value, "from-wal");
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "glibc baseline requires GNU counterparts and records only known musl alternatives",
  () => {
    const ffi = "/cli/node_modules/@yuuang/ffi-rs-linux-x64-gnu/ffi-rs.linux-x64-gnu.node";
    const ffiMusl = ffi.replaceAll("-gnu", "-musl");
    const koffi = "/cli/node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node";
    const koffiMusl = koffi.replace("/linux_x64/", "/musl_x64/");
    const unknown = "/cli/node_modules/unknown-musl/other.node";
    const result = selectGlibcNativeFiles([ffi, ffiMusl, koffi, koffiMusl, unknown]);
    NodeAssert.deepEqual(result.selected, [ffi, koffi, unknown]);
    NodeAssert.deepEqual(
      result.alternatives.map((entry) => entry.counterpart),
      [ffi, koffi],
    );
    NodeAssert.throws(() => selectGlibcNativeFiles([ffiMusl, koffi, koffiMusl]), /missing GNU/);
    NodeAssert.throws(() => selectGlibcNativeFiles([ffi, ffiMusl, koffiMusl]), /missing GNU/);
  },
);
