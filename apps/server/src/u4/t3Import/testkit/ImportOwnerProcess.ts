// @effect-diagnostics nodeBuiltinImport:off
// A test-owned child holds real synthetic files and an auxiliary SQLite admission lease.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { openExclusiveSqliteLock } from "../../../persistence/exclusiveSqliteLock.ts";
import * as Publisher from "../T3ImportPublisher.ts";
import { digest } from "../t3ImportPlan.ts";

const [stateDir, attachmentsDir] = process.argv.slice(2);
if (!stateDir || !attachmentsDir) throw new Error("Missing private test paths");
const directory = NodePath.join(stateDir, "imports", "t3");
await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
const owner = openExclusiveSqliteLock(NodePath.join(directory, "owner.sqlite"), 0, 0o600);
await NodeFSP.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
const stageDir = NodePath.join(directory, "sessions", "synthetic-owner", "units", "attempt");
await NodeFSP.mkdir(stageDir, { recursive: true, mode: 0o700 });
const stagePath = NodePath.join(stageDir, "stage.sqlite");
const stage = new NodeSqlite.DatabaseSync(stagePath);
stage.exec("CREATE TABLE t3i_seal(nonce TEXT); INSERT INTO t3i_seal VALUES ('synthetic-owner');");
stage.close();
await NodeFSP.chmod(stagePath, 0o400);
const privatePath = NodePath.join(directory, "sessions", "synthetic-owner", "asset.html");
const bytes = Buffer.from("Synthetic live-owner asset");
await NodeFSP.writeFile(privatePath, bytes, { mode: 0o600 });
const id = "thread-11111111-1111-4111-8111-111111111111-html";
const publication = await Publisher.beginPublication(
  { stateDir, attachmentsDir },
  ["synthetic-owner", "thread:owner", 1],
  "synthetic-job",
  [
    {
      sourceAssetId: "source",
      kind: "tool",
      selectedRelativeName: "source.html",
      actualExtension: "html",
      id,
      finalName: id + ".html",
      sha256: digest(bytes),
      bytes: bytes.length,
      privatePath,
      warnings: [],
      absenceNames: [id + ".html", id + ".html.txt"],
    },
  ],
);
await Publisher.publishFiles({ stateDir, attachmentsDir }, publication);
process.stdout.write(
  JSON.stringify({ stagePath, finalPath: NodePath.join(attachmentsDir, id + ".html") }) + "\n",
);
process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once("end", resolve));
owner.db.close();
