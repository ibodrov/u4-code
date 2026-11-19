// @effect-diagnostics nodeBuiltinImport:off
// Crash fixtures use real hard links and inode replacement in a private temporary home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import * as Publisher from "./T3ImportPublisher.ts";
import { attachmentCandidatesById } from "../../attachmentStore.ts";
import { digest } from "./t3ImportPlan.ts";
import type { StagedAsset } from "./t3ImportAssets.ts";

async function fixture() {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "u4-t3-publish-"));
  const attachmentsDir = NodePath.join(stateDir, "attachments");
  await NodeFSP.mkdir(attachmentsDir, { mode: 0o700 });
  const bytes = Buffer.alloc(100_000, 42),
    privatePath = NodePath.join(stateDir, "staged");
  await NodeFSP.writeFile(privatePath, bytes);
  const id = "thread-11111111-1111-4111-8111-111111111111-html",
    finalName = id + ".html";
  const asset: StagedAsset = {
    sourceAssetId: "source",
    kind: "tool",
    selectedRelativeName: "source.html",
    actualExtension: "html",
    id,
    finalName,
    sha256: digest(bytes),
    bytes: bytes.length,
    privatePath,
    warnings: [],
    absenceNames: [finalName, finalName + ".txt"],
  };
  return {
    paths: { stateDir, attachmentsDir },
    asset,
    finalPath: NodePath.join(attachmentsDir, finalName),
    cleanup: () => NodeFSP.rm(stateDir, { recursive: true, force: true }),
  };
}
const key = ["source-environment", "thread:source", 1] as const;
it.each(["same", "different", "dangling-link"])(
  "never adopts or removes a pre-existing destination: %s",
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === "dangling-link") await NodeFSP.symlink("/does-not-exist", f.finalPath);
      else
        await NodeFSP.writeFile(
          f.finalPath,
          kind === "same" ? Buffer.alloc(100_000, 42) : "unrelated",
        );
      const before = await NodeFSP.lstat(f.finalPath);
      await expect(
        Publisher.beginPublication(f.paths, key, "job", [f.asset]),
      ).rejects.toMatchObject({ reason: "attachment-conflict" });
      expect((await NodeFSP.lstat(f.finalPath)).ino).toBe(before.ino);
      expect(await Publisher.listPublications(f.paths)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
);
it.each([
  "partial-copy",
  "linked-before-journal",
  "replacement",
  "committed",
  "cleanup-absent",
  "cleanup-committed",
])("reconciles publication by actual inode ownership after %s", async (kind) => {
  const f = await fixture();
  try {
    const publication = await Publisher.beginPublication(f.paths, key, "job", [f.asset]);
    if (kind === "partial-copy")
      await expect(
        Publisher.publishFiles(f.paths, publication, {
          afterChunk: async () => {
            throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
    else if (kind === "linked-before-journal")
      await expect(
        Publisher.publishFiles(f.paths, publication, {
          afterLink: async () => {
            throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
    else await Publisher.publishFiles(f.paths, publication);
    if (kind === "replacement") {
      await NodeFSP.unlink(f.finalPath);
      await NodeFSP.writeFile(f.finalPath, "unrelated replacement");
    }
    const before = await Publisher.loadPublication(f.paths, key);
    await expect(
      Publisher.finishPublication(f.paths, publication.entry, "unknown"),
    ).rejects.toMatchObject({ reason: "unknown" });
    expect(await Publisher.loadPublication(f.paths, key)).toEqual(before);
    await expect(
      Publisher.beginPublication(f.paths, key, "retry", [f.asset]),
    ).rejects.toMatchObject({ reason: "unknown" });
    expect(await Publisher.loadPublication(f.paths, key)).toEqual(before);
    if (kind.startsWith("cleanup-")) {
      if (kind === "cleanup-absent") await NodeFSP.unlink(f.finalPath);
      await NodeFSP.unlink(before!.files[0]!.privatePath);
      await NodeFSP.rmdir(NodePath.dirname(before!.files[0]!.privatePath));
    }
    await Publisher.finishPublication(
      f.paths,
      publication.entry,
      kind === "committed" || kind === "cleanup-committed" ? "committed" : "absent",
    );
    expect(await Publisher.loadPublication(f.paths, key)).toBeNull();
    if (kind === "replacement")
      expect(await NodeFSP.readFile(f.finalPath, "utf8")).toBe("unrelated replacement");
    else if (kind === "committed" || kind === "cleanup-committed")
      expect((await NodeFSP.readFile(f.finalPath)).length).toBe(100_000);
    else await expect(NodeFSP.lstat(f.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});
it.each(["strict-reader", "message", "sidecar"])(
  "guards the actual strict missing-ID paths without writing a placeholder: %s",
  async (kind) => {
    const f = await fixture();
    try {
      const id = f.asset.id.replace(/-html$/, "-missing"),
        candidates = attachmentCandidatesById(id);
      expect(candidates).toEqual([id + ".missing"]);
      const names = [...candidates, id + ".pdf"].flatMap((name) => [name, name + ".txt"]);
      const asset: StagedAsset = {
        ...f.asset,
        id,
        finalName: null,
        sha256: null,
        privatePath: null,
        actualExtension: null,
        bytes: 0,
        reason: "missing",
        absenceNames: names,
      };
      const name =
        kind === "strict-reader"
          ? candidates[0]!
          : kind === "message"
            ? id + ".pdf"
            : id + ".missing.txt";
      await NodeFSP.writeFile(NodePath.join(f.paths.attachmentsDir, name), "unrelated");
      await expect(Publisher.beginPublication(f.paths, key, "job", [asset])).rejects.toMatchObject({
        reason: "attachment-conflict",
      });
      expect(await NodeFSP.readFile(NodePath.join(f.paths.attachmentsDir, name), "utf8")).toBe(
        "unrelated",
      );
    } finally {
      await f.cleanup();
    }
  },
);
