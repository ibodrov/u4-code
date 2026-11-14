import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProjectId } from "@t3tools/contracts";
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
      yield* git(["add", "tracked.txt", ".gitignore"]);
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
