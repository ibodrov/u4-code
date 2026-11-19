// @effect-diagnostics nodeBuiltinImport:off
// Descriptor anchoring, hard links and inode witnesses require Node filesystem primitives.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { T3ImportError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isAbsent, safeName, type StagedAsset } from "./t3ImportAssets.ts";
import { digest, type UnitKey } from "./t3ImportPlan.ts";

const JournalFile = Schema.Struct({
  finalName: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  state: Schema.Literals(["planned", "private", "published"]),
  privatePath: Schema.String,
  dev: Schema.NullOr(Schema.Number),
  ino: Schema.NullOr(Schema.Number),
});
const Journal = Schema.Struct({
  unitKey: Schema.Tuple([Schema.String, Schema.String, Schema.Number]),
  jobId: Schema.String,
  attemptId: Schema.String,
  files: Schema.Array(JournalFile),
});
const decodeJournal = Schema.decodeSync(Schema.fromJsonString(Journal));
export type PublicationJournal = typeof Journal.Type;
export type PublicationPaths = { readonly stateDir: string; readonly attachmentsDir: string };
const inodeMatches = (
  stat: { dev: number; ino: number },
  file: { dev: number | null; ino: number | null },
) => stat.dev === file.dev && stat.ino === file.ino;
const unitHash = (key: UnitKey) => digest(JSON.stringify(key));
const basePath = (paths: PublicationPaths) => NodePath.join(paths.stateDir, "imports", "t3");
const journalPath = (paths: PublicationPaths, key: UnitKey) =>
  NodePath.join(basePath(paths), "journal", unitHash(key) + ".json");
const attemptPath = (paths: PublicationPaths, key: UnitKey, attempt: string) =>
  NodePath.join(basePath(paths), "publish", unitHash(key), attempt);
async function statOrAbsent(path: string) {
  try {
    return await NodeFSP.lstat(path);
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cause;
  }
}
async function syncDirectory(path: string) {
  const dir = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function readEntry(path: string) {
  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid journal");
    return decodeJournal(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
function validateEntry(paths: PublicationPaths, entry: PublicationJournal, key: UnitKey) {
  if (
    JSON.stringify(entry.unitKey) !== JSON.stringify(key) ||
    !/^[0-9a-f-]{36}$/.test(entry.attemptId) ||
    !Number.isSafeInteger(key[2]) ||
    key[2] < 1
  )
    throw new T3ImportError({ reason: "unknown", stage: "journal-identity" });
  const privateDir = attemptPath(paths, key, entry.attemptId);
  const names = new Set<string>();
  for (const file of entry.files) {
    if (
      !safeName(file.finalName) ||
      names.has(file.finalName) ||
      file.privatePath !== NodePath.join(privateDir, file.finalName) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new T3ImportError({ reason: "unknown", stage: "journal-files" });
    if (file.state !== "planned" && (file.dev === null || file.ino === null))
      throw new T3ImportError({ reason: "unknown", stage: "journal-witness" });
    names.add(file.finalName);
  }
}
export async function loadPublication(
  paths: PublicationPaths,
  key: UnitKey,
): Promise<PublicationJournal | null> {
  try {
    const entry = await readEntry(journalPath(paths, key));
    validateEntry(paths, entry, key);
    return entry;
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw new T3ImportError({ reason: "unknown", stage: "prior-journal", cause });
  }
}
export async function listPublications(paths: PublicationPaths) {
  const dir = NodePath.join(basePath(paths), "journal");
  let names: string[];
  try {
    names = await NodeFSP.readdir(dir);
  } catch (cause) {
    if (isAbsent(cause)) return [];
    throw cause;
  }
  const entries: PublicationJournal[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const entry = await readEntry(NodePath.join(dir, name));
    validateEntry(paths, entry, entry.unitKey);
    if (name !== unitHash(entry.unitKey) + ".json")
      throw new T3ImportError({ reason: "unknown", stage: "journal-name" });
    entries.push(entry);
  }
  return entries;
}
async function assertCurrent(paths: PublicationPaths, entry: PublicationJournal) {
  const current = await loadPublication(paths, entry.unitKey);
  if (!current || current.attemptId !== entry.attemptId || current.jobId !== entry.jobId)
    throw new T3ImportError({ reason: "unknown", stage: "journal-attempt" });
}
async function updateEntry(paths: PublicationPaths, entry: PublicationJournal) {
  await assertCurrent(paths, entry);
  const path = journalPath(paths, entry.unitKey);
  const temporary = `${path}.${entry.attemptId}.tmp`;
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(entry));
    await file.sync();
  } finally {
    await file.close();
  }
  await assertCurrent(paths, entry);
  await NodeFSP.rename(temporary, path);
  await syncDirectory(NodePath.dirname(path));
}

export async function beginPublication(
  paths: PublicationPaths,
  key: UnitKey,
  jobId: string,
  assets: ReadonlyArray<StagedAsset>,
) {
  // The service holds its job lock and reconciles a prior entry before calling this operation.
  if (await loadPublication(paths, key))
    throw new T3ImportError({ reason: "unknown", stage: "unresolved-prior-attempt" });
  for (const name of new Set(assets.flatMap((asset) => asset.absenceNames))) {
    if (!safeName(name))
      throw new T3ImportError({ reason: "attachment-conflict", stage: "filename" });
    if (await statOrAbsent(NodePath.join(paths.attachmentsDir, name)))
      throw new T3ImportError({ reason: "attachment-conflict", stage: "absence-guard" });
  }
  const attemptId = NodeCrypto.randomUUID();
  const privateDir = attemptPath(paths, key, attemptId);
  await NodeFSP.mkdir(NodePath.dirname(privateDir), { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(privateDir, { mode: 0o700 });
  if ((await NodeFSP.stat(privateDir)).dev !== (await NodeFSP.stat(paths.attachmentsDir)).dev)
    throw new T3ImportError({ reason: "staging-failed", stage: "publish-filesystem" });
  const files = assets.flatMap((asset) =>
    asset.finalName && asset.privatePath && asset.sha256
      ? [
          {
            finalName: asset.finalName,
            sha256: asset.sha256,
            size: asset.bytes,
            source: asset.privatePath,
          },
          ...(asset.sidecar
            ? [
                {
                  finalName: asset.finalName + ".txt",
                  sha256: asset.sidecar.sha256,
                  size: asset.sidecar.bytes,
                  source: asset.sidecar.privatePath,
                },
              ]
            : []),
        ]
      : [],
  );
  const entry: PublicationJournal = {
    unitKey: key,
    jobId,
    attemptId,
    files: files.map((file) => ({
      finalName: file.finalName,
      sha256: file.sha256,
      size: file.size,
      state: "planned",
      privatePath: NodePath.join(privateDir, file.finalName),
      dev: null,
      ino: null,
    })),
  };
  const path = journalPath(paths, key);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const journal = await NodeFSP.open(path, "wx", 0o600);
  try {
    await journal.writeFile(JSON.stringify(entry));
    await journal.sync();
  } finally {
    await journal.close();
  }
  await syncDirectory(NodePath.dirname(path));
  return { entry, files };
}
export async function publishFiles(
  paths: PublicationPaths,
  publication: Awaited<ReturnType<typeof beginPublication>>,
  hooks: {
    readonly afterChunk?: () => Promise<void>;
    readonly beforeLink?: () => Promise<void>;
    readonly afterLink?: () => Promise<void>;
  } = {},
) {
  let entry = publication.entry;
  for (const [index, source] of publication.files.entries()) {
    await assertCurrent(paths, entry);
    const planned = entry.files[index]!;
    const file = await NodeFSP.open(planned.privatePath, "wx", 0o600);
    try {
      const input = await NodeFSP.open(
        source.source,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      const hash = NodeCrypto.createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          size += chunk.length;
          if (size > planned.size) throw new Error("Staged asset changed");
          let offset = 0;
          while (offset < chunk.length)
            offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
          await hooks.afterChunk?.();
        }
      } finally {
        await input.close();
      }
      if (size !== planned.size || hash.digest("hex") !== planned.sha256)
        throw new Error("Staged asset changed");
      await file.sync();
      const stat = await file.stat();
      entry = Object.assign({}, entry, {
        files: entry.files.map((f, i) =>
          i === index ? { ...f, dev: stat.dev, ino: stat.ino, state: "private" } : f,
        ),
      });
    } finally {
      await file.close();
    }
    await updateEntry(paths, entry);
    await hooks.beforeLink?.();
    await NodeFSP.link(planned.privatePath, NodePath.join(paths.attachmentsDir, planned.finalName));
    await hooks.afterLink?.();
    await syncDirectory(paths.attachmentsDir);
    entry = {
      ...entry,
      files: entry.files.map((f, i) => (i === index ? { ...f, state: "published" } : f)),
    };
    await updateEntry(paths, entry);
  }
  return entry;
}

export async function finishPublication(
  paths: PublicationPaths,
  entry: PublicationJournal,
  outcome: "committed" | "absent" | "unknown",
) {
  if (outcome === "unknown")
    throw new T3ImportError({ reason: "unknown", stage: "commit-outcome" });
  await assertCurrent(paths, entry);
  const current = await loadPublication(paths, entry.unitKey);
  if (!current) throw new T3ImportError({ reason: "unknown", stage: "journal-disappeared" });
  const privateDir = attemptPath(paths, entry.unitKey, entry.attemptId);
  const directory = await statOrAbsent(privateDir);
  if (
    directory &&
    (!directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0)
  )
    throw new T3ImportError({ reason: "unknown", stage: "private-directory" });
  const ownedFinals: string[] = [],
    privateFiles: string[] = [];
  // Validate all witnesses before removing any of them; unresolved ownership preserves the entire entry.
  for (const file of current.files) {
    const privateStat = await statOrAbsent(file.privatePath);
    const finalPath = NodePath.join(paths.attachmentsDir, file.finalName);
    const finalStat = await statOrAbsent(finalPath);
    if (
      file.state !== "planned" &&
      ((privateStat && (!privateStat.isFile() || !inodeMatches(privateStat, file))) ||
        (!privateStat && outcome === "absent" && finalStat && inodeMatches(finalStat, file)))
    )
      throw new T3ImportError({ reason: "unknown", stage: "private-inode" });
    if (privateStat && (!directory || !privateStat.isFile() || privateStat.uid !== directory.uid))
      throw new T3ImportError({ reason: "unknown", stage: "private-file" });
    if (
      file.state === "planned" &&
      finalStat &&
      privateStat &&
      inodeMatches(finalStat, privateStat)
    )
      throw new T3ImportError({ reason: "unknown", stage: "unrecorded-link" });
    if (privateStat) privateFiles.push(file.privatePath);
    if (
      outcome === "absent" &&
      finalStat &&
      file.state !== "planned" &&
      inodeMatches(finalStat, file)
    )
      ownedFinals.push(finalPath);
  }
  for (const path of ownedFinals) {
    const file = current.files.find(
      (file) => NodePath.join(paths.attachmentsDir, file.finalName) === path,
    )!;
    const stat = await statOrAbsent(path);
    if (stat && inodeMatches(stat, file)) await NodeFSP.unlink(path);
  }
  for (const path of privateFiles) {
    await assertCurrent(paths, entry);
    const file = current.files.find((file) => file.privatePath === path)!;
    const stat = await statOrAbsent(path);
    if (stat && (file.state === "planned" || inodeMatches(stat, file))) await NodeFSP.unlink(path);
    else if (stat) throw new T3ImportError({ reason: "unknown", stage: "private-inode" });
  }
  await assertCurrent(paths, entry);
  if (directory) await NodeFSP.rmdir(privateDir);
  await NodeFSP.unlink(journalPath(paths, entry.unitKey));
  await syncDirectory(NodePath.join(basePath(paths), "journal"));
}
