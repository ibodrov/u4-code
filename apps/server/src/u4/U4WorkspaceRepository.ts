import { U4ClusterProfile, U4KubernetesWorkspace, U4WorkspaceError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { encodeJson } from "./U4KubectlClient.ts";
import * as ServerConfig from "../config.ts";

const Ledger = Schema.Struct({
  ownerId: Schema.String,
  workspaces: Schema.Array(U4KubernetesWorkspace),
});
export class U4WorkspaceRepository extends Context.Service<
  U4WorkspaceRepository,
  {
    readonly directory: string;
    readonly profiles: Effect.Effect<ReadonlyArray<U4ClusterProfile>, U4WorkspaceError>;
    readonly read: Effect.Effect<typeof Ledger.Type, U4WorkspaceError>;
    readonly save: (ledger: typeof Ledger.Type) => Effect.Effect<void, U4WorkspaceError>;
  }
>()("t3/u4/U4WorkspaceRepository") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const directory = path.join(config.baseDir, "kubernetes");
  const ledgerPath = path.join(directory, "workspaces.json");
  const read = Effect.fn("U4WorkspaceRepository.read")(
    function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      if (!(yield* fs.exists(ledgerPath))) {
        const ownerId = yield* random.uuidV4();
        yield* writeFileStringAtomically({
          filePath: ledgerPath,
          contents: yield* encodeJson({ ownerId, workspaces: [] }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }
      return yield* fs
        .readFileString(ledgerPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))));
    },
    Effect.mapError((cause) => new U4WorkspaceError({ stage: "storage", cause })),
  );
  const save = Effect.fn("U4WorkspaceRepository.save")(
    function* (ledger: typeof Ledger.Type) {
      yield* writeFileStringAtomically({
        filePath: ledgerPath,
        contents: yield* encodeJson(ledger),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    Effect.mapError((cause) => new U4WorkspaceError({ stage: "storage", cause })),
  );
  const profiles = Effect.gen(function* () {
    const file = path.join(directory, "profiles.json");
    if (!(yield* fs.exists(file))) return [];
    return yield* fs
      .readFileString(file)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(U4ClusterProfile))),
        ),
      );
  }).pipe(Effect.mapError((cause) => new U4WorkspaceError({ stage: "configuration", cause })));
  return U4WorkspaceRepository.of({ directory, profiles, read: read(), save });
});
export const layer = Layer.effect(U4WorkspaceRepository, make);
