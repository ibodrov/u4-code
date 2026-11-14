import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import {
  ProjectId,
  U4WorkspaceError,
  type U4KubernetesWorkspace,
  type U4ClusterProfile,
} from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as U4WorkspaceTransferService from "./U4WorkspaceTransferService.ts";
import * as U4WorkspaceRepository from "./U4WorkspaceRepository.ts";
import * as U4KubectlClient from "./U4KubectlClient.ts";

const decodeProjectRow = Schema.decodeUnknownSync(ProjectStore.ProjectRow);
it.live(
  "bundles only a clean committed snapshot, preserves the source, and refuses dirty/LFS/submodule sources",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "u4-transfer-test-" });
      const cwd = `${root}/source`,
        directory = `${root}/manager`;
      yield* fs.makeDirectory(cwd);
      yield* fs.makeDirectory(directory);
      const git = (args: ReadonlyArray<string>) =>
        vcs
          .run({ operation: "test.u4", command: "git", args, cwd })
          .pipe(Effect.map((r) => r.stdout.trim()));
      yield* git(["init", "-b", "main"]);
      yield* fs.writeFileString(`${cwd}/tracked.txt`, "committed\n");
      yield* fs.writeFileString(`${cwd}/.gitignore`, ".env\n");
      yield* fs.writeFileString(`${cwd}/.env.example`, "PLACEHOLDER=replace-me\n");
      yield* git(["add", "tracked.txt", ".gitignore", ".env.example"]);
      yield* git(["commit", "-m", "fixture"]);
      yield* fs.writeFileString(`${cwd}/.env`, "IGNORED=do-not-transfer\n");
      yield* git(["remote", "add", "origin", "https://github.com/walmartlabs/concord.git"]);
      const head = yield* git(["rev-parse", "HEAD"]),
        refs = yield* git(["show-ref"]);
      const row = decodeProjectRow({
        projectId: "project",
        title: "Source",
        hasCustomTitle: false,
        workspaceRoot: cwd,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: "2026-11-13T00:00:00Z",
        updatedAt: "2026-11-13T00:00:00Z",
        deletedAt: null,
      });
      const layer = Layer.effect(
        U4WorkspaceTransferService.U4WorkspaceTransferService,
        U4WorkspaceTransferService.make,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(row),
            }),
            Layer.mock(U4WorkspaceRepository.U4WorkspaceRepository)({ directory }),
            Layer.mock(U4KubectlClient.U4KubectlClient)({}),
            VcsProcess.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const transfer = yield* U4WorkspaceTransferService.U4WorkspaceTransferService;
        const snapshot = yield* transfer.snapshot(ProjectId.make("project"), "snapshot");
        expect(snapshot.baseSha).toBe(head);
        expect(snapshot.sourceRemoteUrl).toBe("https://github.com/walmartlabs/concord.git");
        expect(yield* git(["remote", "get-url", "origin"])).toBe(
          "https://github.com/walmartlabs/concord.git",
        );
        expect(snapshot.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(yield* git(["show-ref"])).toBe(refs);
        expect(yield* git(["status", "--porcelain"])).toBe("");
        const target = `${root}/independent`;
        yield* vcs.run({
          operation: "test.clone",
          command: "git",
          args: ["clone", snapshot.bundlePath, target],
          cwd: root,
        });
        expect(yield* fs.exists(`${target}/.env`)).toBe(false);
        yield* git(["remote", "set-url", "origin", "git@github.com:walmartlabs/concord.git"]);
        expect(
          (yield* transfer.snapshot(ProjectId.make("project"), "ssh-origin")).sourceRemoteUrl,
        ).toBe("https://github.com/walmartlabs/concord.git");
        expect(yield* git(["remote", "get-url", "origin"])).toBe(
          "git@github.com:walmartlabs/concord.git",
        );
        yield* git([
          "remote",
          "set-url",
          "origin",
          "https://placeholder-user:placeholder-token@example.invalid/repo.git",
        ]);
        expect(
          (yield* transfer.snapshot(ProjectId.make("project"), "credential-origin"))
            .sourceRemoteUrl,
        ).toBeUndefined();
        yield* fs.writeFileString(`${cwd}/tracked.txt`, "dirty\n");
        expect(
          (yield* Effect.flip(transfer.snapshot(ProjectId.make("project"), "dirty"))).stage,
        ).toBe("snapshot");
        yield* git(["restore", "tracked.txt"]);
        yield* fs.writeFileString(`${cwd}/.env.example`, "API_KEY=fixture-sensitive-value\n");
        yield* git(["commit", "-am", "secret template fixture"]);
        expect(
          (yield* Effect.flip(transfer.snapshot(ProjectId.make("project"), "secret-template")))
            .stage,
        ).toBe("snapshot");
        yield* fs.writeFileString(`${cwd}/.env.example`, "API_KEY=replace-me\n");
        yield* git(["commit", "-am", "placeholder template fixture"]);
        yield* fs.writeFileString(
          `${cwd}/.gitattributes`,
          "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        yield* git(["add", ".gitattributes"]);
        yield* git(["commit", "-m", "lfs fixture"]);
        expect(
          (yield* Effect.flip(transfer.snapshot(ProjectId.make("project"), "lfs"))).stage,
        ).toBe("snapshot");
        yield* git(["rm", ".gitattributes"]);
        yield* fs.makeDirectory(`${cwd}/vendor`);
        yield* git(["update-index", "--add", "--cacheinfo", `160000,${head},vendor`]);
        yield* git(["commit", "-m", "submodule fixture"]);
        expect(
          (yield* Effect.flip(transfer.snapshot(ProjectId.make("project"), "submodule"))).stage,
        ).toBe("snapshot");
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.live(
  "verifies untrusted result receipts, refs, ancestry and exact heads, and returns an applicable patch larger than stdout limits",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const digest = yield* Digest.Digest;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "u4-export-test-" });
      const source = `${root}/source`,
        directory = `${root}/manager`;
      yield* fs.makeDirectory(source);
      yield* fs.makeDirectory(directory);
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        vcs
          .run({ operation: "test.export", command: "git", cwd, args })
          .pipe(Effect.map((r) => r.stdout.trim()));
      yield* git(source, ["init", "-b", "base"]);
      yield* git(source, ["config", "user.name", "Fixture"]);
      yield* git(source, ["config", "user.email", "fixture@example.invalid"]);
      yield* fs.writeFileString(`${source}/file.txt`, "before\n");
      yield* fs.writeFileString(`${source}/large.txt`, "before\n".repeat(700000));
      yield* git(source, ["add", "."]);
      yield* git(source, ["commit", "-m", "base"]);
      const base = yield* git(source, ["rev-parse", "HEAD"]);
      yield* git(source, ["checkout", "-b", "release/1.2"]);
      yield* fs.writeFileString(`${source}/file.txt`, "after\n");
      yield* fs.writeFileString(`${source}/large.txt`, "after\n".repeat(700000));
      yield* git(source, ["commit", "-am", "result"]);
      const head = yield* git(source, ["rev-parse", "HEAD"]);
      const bundle = `${root}/result.bundle`;
      let scenario = "valid";
      let bundleSha = "";
      let receiptBase = base;
      const workspace = {
        id: "ws-test",
        podName: "ws-test-1",
        baseSha: base,
      } as U4KubernetesWorkspace;
      const profile = {} as U4ClusterProfile;
      const layer = Layer.effect(
        U4WorkspaceTransferService.U4WorkspaceTransferService,
        U4WorkspaceTransferService.make,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(U4WorkspaceRepository.U4WorkspaceRepository)({ directory }),
            Layer.mock(U4KubectlClient.U4KubectlClient)({
              run: (_profile, args) =>
                Effect.gen(function* () {
                  if (args[0] === "cp") {
                    yield* fs.copyFile(bundle, args[2]!);
                    return "";
                  }
                  const id = args.at(-1)!;
                  return JSON.stringify({
                    head: scenario === "receipt-head" ? base : head,
                    base: scenario === "receipt-base" ? head : receiptBase,
                    path: `/workspace/${id}.bundle`,
                    sha256: scenario === "hash" ? "0".repeat(64) : bundleSha,
                  });
                }).pipe(
                  Effect.mapError((cause) => new U4WorkspaceError({ stage: "transfer", cause })),
                ),
              download: (_profile, _args, destination) =>
                fs
                  .copyFile(bundle, destination)
                  .pipe(
                    Effect.mapError((cause) => new U4WorkspaceError({ stage: "transfer", cause })),
                  ),
            }),
            VcsProcess.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const transfer = yield* U4WorkspaceTransferService.U4WorkspaceTransferService;
        const input = {
          id: workspace.id,
          branch: "release/1.2",
          expectedHead: head,
          title: "Targeted dependency change",
          body: "Local only",
        };
        const prepare = Effect.fn("test.export.prepare")(function* (refs: ReadonlyArray<string>) {
          yield* fs.remove(bundle, { force: true });
          yield* git(source, ["bundle", "create", bundle, ...refs]);
          bundleSha = yield* digest.digestHex(Digest.sha256, yield* fs.readFile(bundle));
        });
        yield* prepare(["refs/heads/release/1.2"]);
        for (scenario of ["receipt-head", "receipt-base", "hash"]) {
          expect((yield* Effect.flip(transfer.export(profile, workspace, input))).stage).toBe(
            "transfer",
          );
        }
        scenario = "valid";
        yield* git(source, ["branch", "rogue"]);
        yield* prepare(["refs/heads/release/1.2", "refs/heads/rogue"]);
        expect((yield* Effect.flip(transfer.export(profile, workspace, input))).stage).toBe(
          "transfer",
        );
        yield* git(source, ["update-ref", "refs/heads/release/1.2", base]);
        yield* prepare(["refs/heads/release/1.2"]);
        expect((yield* Effect.flip(transfer.export(profile, workspace, input))).stage).toBe(
          "transfer",
        );
        yield* git(source, ["update-ref", "refs/heads/release/1.2", head]);
        yield* prepare(["refs/heads/release/1.2"]);
        const tree = yield* git(source, ["rev-parse", `${head}^{tree}`]);
        const unrelated = yield* git(source, ["commit-tree", tree, "-m", "unrelated root"]);
        const checkpoint = "refs/t3/orchestration-v2/checkpoints/test/ordinal/0";
        yield* git(source, ["update-ref", checkpoint, unrelated]);
        yield* prepare(["refs/heads/release/1.2", checkpoint]);
        receiptBase = unrelated;
        expect(
          (yield* Effect.flip(
            transfer.export(profile, { ...workspace, baseSha: unrelated }, { ...input }),
          )).stage,
        ).toBe("transfer");
        receiptBase = base;
        yield* git(source, ["update-ref", "-d", checkpoint]);
        yield* prepare(["refs/heads/release/1.2"]);
        const result = yield* transfer.export(profile, workspace, input);
        expect(yield* git(result.stagingPath, ["rev-parse", "refs/heads/release/1.2"])).toBe(head);
        expect(yield* git(result.stagingPath, ["remote"])).toBe("");
        const patch = `${result.stagingPath}/../diff.patch`;
        expect(Number((yield* fs.stat(patch)).size)).toBeGreaterThan(4_000_000);
        expect((yield* fs.readFileString(patch)).endsWith("\n")).toBe(true);
        yield* git(result.stagingPath, ["checkout", "--detach", base]);
        yield* git(result.stagingPath, ["apply", "--index", patch]);
        expect(yield* git(result.stagingPath, ["write-tree"])).toBe(
          yield* git(source, ["rev-parse", `${head}^{tree}`]),
        );
        const failures = (yield* fs.readDirectory(`${directory}/results`)).filter(
          (id) => id !== result.stagingPath.split("/").at(-2),
        );
        expect(failures).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
