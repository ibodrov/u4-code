import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { U4WorkspaceError, type U4ClusterProfile } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";

export class U4KubectlClient extends Context.Service<
  U4KubectlClient,
  {
    readonly run: (
      profile: U4ClusterProfile,
      args: ReadonlyArray<string>,
      stdin?: string,
    ) => Effect.Effect<string, U4WorkspaceError>;
  }
>()("t3/u4/U4KubectlClient") {}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const run = Effect.fn("U4KubectlClient.run")(function* (
    profile: U4ClusterProfile,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    const result = yield* processRunner
      .run({
        command: "kubectl",
        args: ["--context", profile.context, "--namespace", profile.namespace, ...args],
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "3 minutes",
        maxOutputBytes: 4_000_000,
      })
      .pipe(Effect.mapError((cause) => new U4WorkspaceError({ stage: "cluster", cause })));
    if (result.code !== 0 || result.stdoutTruncated)
      return yield* new U4WorkspaceError({ stage: "cluster" });
    return result.stdout;
  });
  return U4KubectlClient.of({ run });
});
export const layer = Layer.effect(U4KubectlClient, make).pipe(Layer.provide(ProcessRunner.layer));

const Metadata = Schema.Struct({
  name: Schema.String,
  uid: Schema.String,
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  deletionTimestamp: Schema.optionalKey(Schema.String),
});
export const Pod = Schema.Struct({
  metadata: Metadata,
  spec: Schema.Struct({ nodeName: Schema.optionalKey(Schema.String) }),
  status: Schema.Struct({
    phase: Schema.optionalKey(Schema.String),
    containerStatuses: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          restartCount: Schema.Int,
          ready: Schema.Boolean,
          state: Schema.optionalKey(
            Schema.Struct({
              waiting: Schema.optionalKey(
                Schema.Struct({ reason: Schema.optionalKey(Schema.String) }),
              ),
            }),
          ),
          lastState: Schema.optionalKey(
            Schema.Struct({
              terminated: Schema.optionalKey(
                Schema.Struct({ reason: Schema.optionalKey(Schema.String) }),
              ),
            }),
          ),
        }),
      ),
    ),
  }),
});
export const PodList = Schema.Struct({ items: Schema.Array(Pod) });
export const Resource = Schema.Struct({ metadata: Metadata });
export const Service = Schema.Struct({
  metadata: Metadata,
  status: Schema.optionalKey(
    Schema.Struct({
      loadBalancer: Schema.optionalKey(
        Schema.Struct({
          ingress: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                hostname: Schema.optionalKey(Schema.String),
                ip: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});
export const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((cause) => new U4WorkspaceError({ stage: "cluster", cause })),
  );

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const encodeJson = (value: unknown) =>
  encodeJsonString(value).pipe(
    Effect.mapError((cause) => new U4WorkspaceError({ stage: "storage", cause })),
  );
