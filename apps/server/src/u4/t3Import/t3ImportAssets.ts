// @effect-diagnostics nodeBuiltinImport:off
// Descriptor anchoring, hard links and inode witnesses require Node filesystem primitives.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { T3ImportError, type ChatAttachment } from "@t3tools/contracts";
import {
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  previewRecordingIdFromToolItem,
} from "@t3tools/shared/toolOutput";
import {
  attachmentCandidatesById,
  attachmentRelativePath,
  createDeterministicAttachmentId,
  parseAttachmentUuid,
} from "../../attachmentStore.ts";
import { assertLimit, digest, type UnitKey } from "./t3ImportPlan.ts";

export const isAbsent = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
const isImportError = Schema.is(T3ImportError);
const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
const childPath = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
export const safeName = (name: string) =>
  name.length > 0 &&
  name.length <= 256 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");
const sameInode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

export async function openSourceAnchors(
  homePath: string,
  hooks:
    | {
        readonly afterHome?: () => Promise<void>;
        readonly afterUserdata?: () => Promise<void>;
        readonly afterAttachments?: () => Promise<void>;
      }
    | undefined,
  platform: NodeJS.Platform,
) {
  if (platform !== "linux")
    throw new T3ImportError({ reason: "unsupported-platform", stage: "source-anchors" });
  const handles: NodeFSP.FileHandle[] = [];
  try {
    const home = await NodeFSP.open(await NodeFSP.realpath(homePath), directoryFlags);
    handles.push(home);
    const homeIdentity = await home.stat();
    await hooks?.afterHome?.();
    const userdata = await NodeFSP.open(childPath(home.fd, "userdata"), directoryFlags);
    handles.push(userdata);
    const userdataIdentity = await userdata.stat();
    const validate = (stat: NodeFS.Stats) => {
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new T3ImportError({ reason: "unsafe-source", stage: "directory-mode" });
    };
    validate(userdataIdentity);
    await hooks?.afterUserdata?.();
    let attachments: NodeFSP.FileHandle | undefined;
    try {
      attachments = await NodeFSP.open(childPath(userdata.fd, "attachments"), directoryFlags);
      handles.push(attachments);
    } catch (cause) {
      if (!isAbsent(cause)) throw cause;
    }
    const attachmentsIdentity = await attachments?.stat();
    if (attachmentsIdentity) validate(attachmentsIdentity);
    await hooks?.afterAttachments?.();
    const verifyAnchors = async () => {
      const selectedHome = await NodeFSP.open(homePath, directoryFlags);
      try {
        if (!sameInode(await selectedHome.stat(), homeIdentity)) throw new Error("home replaced");
      } finally {
        await selectedHome.close();
      }
      const currentUserdata = await NodeFSP.open(childPath(home.fd, "userdata"), directoryFlags);
      try {
        const stat = await currentUserdata.stat();
        validate(stat);
        if (!sameInode(stat, userdataIdentity)) throw new Error("userdata replaced");
        let currentAttachments: NodeFSP.FileHandle | undefined;
        try {
          currentAttachments = await NodeFSP.open(
            childPath(userdata.fd, "attachments"),
            directoryFlags,
          );
        } catch (cause) {
          if (!isAbsent(cause) || attachmentsIdentity !== undefined) throw cause;
        }
        if (currentAttachments) {
          try {
            const stat = await currentAttachments.stat();
            validate(stat);
            if (!attachmentsIdentity || !sameInode(stat, attachmentsIdentity))
              throw new Error("attachments replaced");
          } finally {
            await currentAttachments.close();
          }
        }
      } catch (cause) {
        throw new T3ImportError({ reason: "source-changed", stage: "anchors", cause });
      } finally {
        await currentUserdata.close();
      }
    };
    const revalidate = async () => {
      try {
        await verifyAnchors();
      } catch (cause) {
        throw new T3ImportError({ reason: "source-changed", stage: "anchors", cause });
      }
    };
    return {
      home,
      userdata,
      attachments,
      revalidate,
      close: async () => {
        for (const h of handles.toReversed()) await h.close();
      },
    };
  } catch (cause) {
    for (const h of handles.toReversed()) await h.close();
    if (isImportError(cause)) throw cause;
    throw new T3ImportError({
      reason: isAbsent(cause) ? "source-not-found" : "unsafe-source",
      stage: "anchors",
      cause,
    });
  }
}
export type SourceAnchors = Awaited<ReturnType<typeof openSourceAnchors>>;
export interface StagedAsset {
  readonly sourceAssetId: string;
  readonly kind: string;
  readonly selectedRelativeName: string | null;
  readonly actualExtension: string | null;
  readonly id: string;
  readonly finalName: string | null;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly privatePath: string | null;
  readonly sidecar?: {
    readonly privatePath: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly reason?: string;
  readonly warnings: ReadonlyArray<string>;
  readonly absenceNames: ReadonlyArray<string>;
}

async function readAnchored(
  anchors: SourceAnchors,
  name: string,
  target: string,
  remaining: number,
): Promise<{ reason: string } | { privatePath: string; sha256: string; bytes: number } | null> {
  if (!safeName(name) || !anchors.attachments) return null;
  let file: NodeFSP.FileHandle;
  try {
    file = await NodeFSP.open(
      childPath(anchors.attachments.fd, name),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (cause) {
    if (isAbsent(cause)) return null;
    return { reason: "unsafe-file" };
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) return { reason: "unsafe-file" };
    assertLimit("unitAssetBytes", before.size);
    if (before.size > remaining)
      throw new T3ImportError({
        reason: "too-large",
        stage: "unitAssetBytes",
        actual: before.size,
        maximum: remaining,
      });
    const targetFile = await NodeFSP.open(target, "wx", 0o600);
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        if (bytes > remaining)
          throw new T3ImportError({
            reason: "too-large",
            stage: "unitAssetBytes",
            actual: bytes,
            maximum: remaining,
          });
        hash.update(buffer.subarray(0, read.bytesRead));
        let written = 0;
        while (written < read.bytesRead)
          written += (await targetFile.write(buffer, written, read.bytesRead - written))
            .bytesWritten;
      }
      await targetFile.sync();
    } finally {
      await targetFile.close();
    }
    const after = await file.stat();
    if (
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      await NodeFSP.unlink(target);
      return { reason: "changed-during-read" as const };
    }
    return { privatePath: target, sha256: hash.digest("hex"), bytes };
  } finally {
    await file.close();
  }
}

type StageAssetInput = {
  anchors: SourceAnchors;
  directory: string;
  sourceAssetId: string;
  kind: string;
  attachment?: ChatAttachment;
  ownerThreadId: string;
  unitKey: UnitKey;
  remaining: number;
};
export async function stageAsset(input: StageAssetInput): Promise<StagedAsset> {
  const token = NodeCrypto.randomUUID();
  try {
    return await stageAssetAttempt(input, token);
  } catch (cause) {
    for (const suffix of ["", "-by-id", "-sidecar"])
      await NodeFSP.rm(NodePath.join(input.directory, token + suffix), { force: true });
    throw cause;
  }
}
async function stageAssetAttempt(input: StageAssetInput, token: string): Promise<StagedAsset> {
  const { anchors, sourceAssetId, attachment, kind } = input;
  const warnings: string[] = [];
  let reason: string | undefined,
    selectedRelativeName: string | null = null;
  let staged: Awaited<ReturnType<typeof readAnchored>> = null;
  const validId = parseAttachmentUuid(sourceAssetId) !== null;
  const metadataPath = attachment && validId ? attachmentRelativePath(attachment) : null;
  const candidates = validId ? attachmentCandidatesById(sourceAssetId) : [];
  if (!validId) reason = "invalid-reference";
  else {
    for (const name of metadataPath ? [metadataPath] : candidates) {
      const result = await readAnchored(
        anchors,
        name,
        NodePath.join(input.directory, token),
        input.remaining,
      );
      if (result !== null) {
        staged = result;
        selectedRelativeName = name;
        break;
      }
    }
    if (metadataPath && staged && "sha256" in staged) {
      let byId: Awaited<ReturnType<typeof readAnchored>> = null;
      for (const name of candidates) {
        byId = await readAnchored(
          anchors,
          name,
          NodePath.join(input.directory, token + "-by-id"),
          input.remaining,
        );
        if (byId !== null) break;
      }
      if (byId && "sha256" in byId) {
        await NodeFSP.unlink(byId.privatePath);
        if (byId.sha256 !== staged.sha256)
          throw new T3ImportError({
            reason: "asset-reference-unsupported",
            stage: "conflicting-consumers",
          });
      } else if (byId !== null)
        throw new T3ImportError({ reason: "source-changed", stage: "asset-comparison" });
      else warnings.push("message-path-only");
    }
  }
  if (!staged) reason ??= "missing-file";
  else if ("reason" in staged) reason = staged.reason;
  const extension =
    selectedRelativeName === null
      ? null
      : NodePath.extname(selectedRelativeName).slice(1).toLowerCase();
  if (
    staged &&
    "sha256" in staged &&
    (!extension || extension === "part" || !/^[a-z0-9]{1,10}$/.test(extension))
  )
    throw new T3ImportError({ reason: "asset-reference-unsupported", stage: "extension" });
  const base = createDeterministicAttachmentId(
    input.ownerThreadId,
    JSON.stringify(["t3-import/3", input.unitKey, sourceAssetId, kind, selectedRelativeName]),
  );
  if (!base)
    throw new T3ImportError({ reason: "asset-reference-unsupported", stage: "destination-id" });
  const available = staged !== null && "sha256" in staged ? staged : null;
  const id = `${base}-${available ? extension : "missing"}`;
  const finalName = available ? `${id}.${extension}` : null;
  const explicitName = attachment ? attachmentRelativePath({ ...attachment, id }) : null;
  if (
    available &&
    (attachmentCandidatesById(id)[0] !== finalName || (attachment && explicitName !== finalName))
  )
    throw new T3ImportError({
      reason: "asset-reference-unsupported",
      stage: "reader-disagreement",
    });
  if (available && !sourceAssetId.endsWith(`-${extension}`))
    warnings.push("legacy-asset-normalized");
  let sidecar: StagedAsset["sidecar"];
  if (available) {
    const result = await readAnchored(
      anchors,
      selectedRelativeName + ".txt",
      NodePath.join(input.directory, token + "-sidecar"),
      input.remaining - available.bytes,
    );
    if (result && "sha256" in result) sidecar = result;
    else if (result) throw new T3ImportError({ reason: "source-changed", stage: "sidecar" });
  }
  const names = [
    ...new Set([...attachmentCandidatesById(id), ...(explicitName ? [explicitName] : [])]),
  ];
  return {
    sourceAssetId,
    kind,
    selectedRelativeName,
    actualExtension: available ? extension : null,
    id,
    finalName,
    sha256: available ? available.sha256 : null,
    bytes: available ? available.bytes : 0,
    privatePath: available ? available.privatePath : null,
    ...(sidecar ? { sidecar } : {}),
    ...(reason ? { reason } : {}),
    warnings,
    absenceNames: names.flatMap((name) => [name, name + ".txt"]),
  };
}

export const toolAssetId = (item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}) =>
  htmlRenderFromToolItem(item)?.attachmentId ??
  mcpAppFromToolItem(item)?.attachmentId ??
  previewRecordingIdFromToolItem(item);

export function rewriteToolAsset(
  item: { readonly toolName: string | null | undefined; readonly output?: unknown },
  from: string,
  to: string,
): unknown {
  let replacements = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const token = JSON.stringify(from),
        count = value.split(token).length - 1;
      if (count > 1)
        throw new T3ImportError({
          reason: "asset-reference-unsupported",
          stage: "duplicate-token",
        });
      if (count === 1) {
        replacements++;
        return value.replace(token, JSON.stringify(to));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if ((k === "attachmentId" || k === "id") && v === from) {
          replacements++;
          return [k, to];
        }
        return [k, walk(v)];
      }),
    );
  };
  const output = walk(item.output);
  if (replacements !== 1 || toolAssetId({ ...item, output }) !== to)
    throw new T3ImportError({ reason: "asset-reference-unsupported", stage: "envelope" });
  // Reversibility prevents changes to any other envelope output.
  if (digest(JSON.stringify(walkReverse(output, to, from))) !== digest(JSON.stringify(item.output)))
    throw new T3ImportError({ reason: "asset-reference-unsupported", stage: "envelope-output" });
  return output;
}
function walkReverse(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.replace(JSON.stringify(from), JSON.stringify(to));
  if (Array.isArray(value)) return value.map((v) => walkReverse(v, from, to));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      (k === "attachmentId" || k === "id") && v === from ? to : walkReverse(v, from, to),
    ]),
  );
}
