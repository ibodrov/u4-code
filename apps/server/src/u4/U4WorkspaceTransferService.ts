import {
  U4WorkspaceError,
  type U4WorkspaceExport,
  type U4WorkspaceExportRequest,
  type U4KubernetesWorkspace,
  type U4ClusterProfile,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as U4WorkspaceRepository from "./U4WorkspaceRepository.ts";
import * as U4KubectlClient from "./U4KubectlClient.ts";

export class U4WorkspaceTransferService extends Context.Service<
  U4WorkspaceTransferService,
  {
    readonly snapshot: (
      projectId: ProjectId,
      id: string,
    ) => Effect.Effect<
      { baseSha: string; snapshotSha256: string; bundlePath: string; sourceRemoteUrl?: string },
      U4WorkspaceError
    >;
    readonly install: (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
    ) => Effect.Effect<void, U4WorkspaceError>;
    readonly export: (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
      input: U4WorkspaceExportRequest,
    ) => Effect.Effect<U4WorkspaceExport, U4WorkspaceError>;
  }
>()("t3/u4/U4WorkspaceTransferService") {}

const isWorkspaceError = Schema.is(U4WorkspaceError);
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess.VcsProcess;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const repository = yield* U4WorkspaceRepository.U4WorkspaceRepository;
  const kubectl = yield* U4KubectlClient.U4KubectlClient;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const git = Effect.fn("U4WorkspaceTransferService.git")(
    function* (cwd: string, args: ReadonlyArray<string>) {
      return (yield* vcs.run({
        operation: "U4WorkspaceTransferService.git",
        command: "git",
        args,
        cwd,
        maxOutputBytes: 4_000_000,
        outputMode: "error",
      })).stdout.trim();
    },
    Effect.mapError((cause) => new U4WorkspaceError({ stage: "transfer", cause })),
  );
  const snapshot = Effect.fn("U4WorkspaceTransferService.snapshot")(
    function* (projectId: ProjectId, id: string) {
      const project = yield* projects
        .get(projectId)
        .pipe(Effect.mapError((cause) => new U4WorkspaceError({ stage: "snapshot", cause })));
      if (Option.isNone(project)) return yield* new U4WorkspaceError({ stage: "snapshot" });
      const cwd = project.value.workspaceRoot;
      const baseSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      const origin = yield* vcs.run({
        operation: "U4WorkspaceTransferService.origin",
        command: "git",
        args: ["config", "--get", "remote.origin.url"],
        cwd,
        allowNonZeroExit: true,
        maxOutputBytes: 4096,
      });
      const remote = origin.stdout.trim();
      const githubSsh = /^git@github\.com:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/.exec(remote);
      const sourceRemoteUrl = /^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(remote)
        ? remote
        : githubSsh
          ? `https://github.com/${githubSsh[1]}`
          : undefined;
      const check = Effect.gen(function* () {
        const status = yield* git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
        const tree = yield* git(cwd, ["ls-tree", "-r", "HEAD"]);
        const attributes = yield* vcs.run({
          operation: "U4WorkspaceTransferService.attributes",
          command: "git",
          args: [
            "grep",
            "-I",
            "-n",
            "filter=lfs",
            "HEAD",
            "--",
            ".gitattributes",
            "**/.gitattributes",
          ],
          cwd,
          allowNonZeroExit: true,
        });
        const envPaths = tree
          .split("\n")
          .map((line) => line.split("\t")[1])
          .filter((p): p is string => p !== undefined && /(^|\/)\.env(?:\.[^/]+)?$/.test(p));
        for (const envPath of envPaths) {
          if (
            ![".env.example", ".env.sample", ".env.template"].includes(envPath.split("/").at(-1)!)
          )
            return yield* new U4WorkspaceError({ stage: "snapshot" });
          const template = yield* git(cwd, ["show", `HEAD:${envPath}`]);
          if (
            /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}/.test(
              template,
            ) ||
            template.split("\n").some((line) => {
              const match =
                /^\s*(?:export\s+)?([A-Za-z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_]*)\s*=\s*(.*)$/i.exec(
                  line,
                );
              if (!match) return false;
              const value = match[2]!
                .replace(/\s+#.*$/, "")
                .trim()
                .replace(/^['"]|['"]$/g, "");
              return (
                value !== "" &&
                !/^(?:\$\{[^}]+\}|<[^>]+>|(?:your[-_]|replace|change|example|placeholder|dummy|test)[A-Za-z0-9_ .-]*)$/i.test(
                  value,
                )
              );
            })
          )
            return yield* new U4WorkspaceError({ stage: "snapshot" });
        }
        if (status || /^160000 /m.test(tree) || attributes.exitCode !== 1)
          return yield* new U4WorkspaceError({ stage: "snapshot" });
      });
      yield* check;
      const bundlePath = `${repository.directory}/${id}.bundle`;
      yield* git(cwd, ["bundle", "create", bundlePath, "HEAD"]);
      yield* git(cwd, ["bundle", "verify", bundlePath]);
      yield* check;
      if ((yield* git(cwd, ["rev-parse", "HEAD"])) !== baseSha)
        return yield* new U4WorkspaceError({ stage: "snapshot" });
      if ((yield* fs.stat(bundlePath)).size > 256 * 1024 * 1024)
        return yield* new U4WorkspaceError({ stage: "snapshot" });
      const snapshotSha256 = yield* digest.digestHex(Digest.sha256, yield* fs.readFile(bundlePath));
      return {
        baseSha,
        snapshotSha256,
        bundlePath,
        ...(sourceRemoteUrl ? { sourceRemoteUrl } : {}),
      };
    },
    Effect.mapError((cause) =>
      isWorkspaceError(cause) ? cause : new U4WorkspaceError({ stage: "snapshot", cause }),
    ),
  );
  const install = Effect.fn("U4WorkspaceTransferService.install")(function* (
    profile: U4ClusterProfile,
    workspace: U4KubernetesWorkspace,
  ) {
    yield* kubectl.run(profile, [
      "wait",
      "--for=condition=Ready",
      `pod/${workspace.podName}`,
      "--timeout=180s",
    ]);
    yield* kubectl.run(profile, [
      "cp",
      `${repository.directory}/${workspace.id}.bundle`,
      `${workspace.podName}:/workspace/source.bundle`,
      "-c",
      "server",
    ]);
    yield* kubectl.run(profile, [
      "exec",
      workspace.podName,
      "-c",
      "server",
      "--",
      "node",
      "/opt/u4/workspace.mjs",
      "import",
      workspace.baseSha,
      workspace.snapshotSha256,
      workspace.sourceRemoteUrl ?? "",
    ]);
  });
  const exportWorkspace = Effect.fn("U4WorkspaceTransferService.export")(
    function* (
      profile: U4ClusterProfile,
      workspace: U4KubernetesWorkspace,
      input: U4WorkspaceExportRequest,
    ) {
      const id = yield* random.uuidV4();
      const output = yield* kubectl.run(profile, [
        "exec",
        workspace.podName,
        "-c",
        "server",
        "--",
        "node",
        "/opt/u4/workspace.mjs",
        "export",
        workspace.baseSha,
        input.branch,
        id,
      ]);
      const receipt = yield* U4KubectlClient.decodeJson(
        Schema.Struct({
          head: Schema.String,
          base: Schema.String,
          sha256: Schema.String,
          path: Schema.String,
        }),
        output,
      );
      if (
        receipt.head !== input.expectedHead ||
        receipt.base !== workspace.baseSha ||
        receipt.path !== `/workspace/${id}.bundle`
      )
        return yield* new U4WorkspaceError({ stage: "transfer" });
      const directory = `${repository.directory}/results/${id}`;
      return yield* Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        const bundlePath = `${directory}/result.bundle`,
          stagingPath = `${directory}/staging`,
          draftPath = `${directory}/pr-draft.json`;
        yield* kubectl.download(
          profile,
          ["exec", workspace.podName, "-c", "server", "--", "cat", receipt.path],
          bundlePath,
          256 * 1024 * 1024,
        );
        if ((yield* fs.stat(bundlePath)).size > 256 * 1024 * 1024)
          return yield* new U4WorkspaceError({ stage: "transfer" });
        const bundleSha256 = yield* digest.digestHex(Digest.sha256, yield* fs.readFile(bundlePath));
        if (bundleSha256 !== receipt.sha256)
          return yield* new U4WorkspaceError({ stage: "transfer" });
        yield* fs.makeDirectory(stagingPath);
        yield* git(stagingPath, ["init"]);
        yield* git(stagingPath, ["bundle", "verify", bundlePath]);
        const refs = (yield* git(stagingPath, ["bundle", "list-heads", bundlePath]))
          .split("\n")
          .map((line) => line.split(" ")[1]!);
        if (
          !refs.includes(`refs/heads/${input.branch}`) ||
          refs.some(
            (ref) =>
              ref !== `refs/heads/${input.branch}` &&
              !ref.startsWith("refs/t3/orchestration-v2/checkpoints/"),
          )
        )
          return yield* new U4WorkspaceError({ stage: "transfer" });
        yield* git(stagingPath, ["fetch", bundlePath, ...refs.map((ref) => `${ref}:${ref}`)]);
        if (
          (yield* git(stagingPath, ["rev-parse", `refs/heads/${input.branch}`])) !==
          input.expectedHead
        )
          return yield* new U4WorkspaceError({ stage: "transfer" });
        yield* git(stagingPath, [
          "merge-base",
          "--is-ancestor",
          workspace.baseSha,
          input.expectedHead,
        ]);
        yield* git(stagingPath, [
          "diff",
          "--binary",
          `--output=${directory}/diff.patch`,
          workspace.baseSha,
          input.expectedHead,
        ]);
        yield* fs.writeFileString(
          draftPath,
          yield* U4KubectlClient.encodeJson({
            title: input.title,
            body: input.body,
            head: input.expectedHead,
            base: workspace.baseSha,
            branch: input.branch,
            published: false,
            approvalRequired: true,
          }),
        );
        return {
          head: input.expectedHead,
          base: workspace.baseSha,
          bundleSha256,
          bundlePath,
          stagingPath,
          draftPath,
        };
      }).pipe(
        Effect.onError(() =>
          fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    },
    Effect.mapError((cause) =>
      isWorkspaceError(cause) ? cause : new U4WorkspaceError({ stage: "transfer", cause }),
    ),
  );
  return U4WorkspaceTransferService.of({ snapshot, install, export: exportWorkspace });
});
export const layer = Layer.effect(U4WorkspaceTransferService, make).pipe(
  Layer.provide(VcsProcess.layer),
);
