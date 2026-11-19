import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

const output: ProcessRunner.ProcessRunOutput = {
  stdout: '{"version":"0.1.10"}',
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

it.effect.each(["latest", "nightly", "0.1.10-u4.8", "0.1.10", "../other"])(
  "refuses release lookup without npm or HTTP activity: %s",
  (spec) =>
    Effect.gen(function* () {
      let spawned = 0;
      let requested = 0;
      const service = yield* NpmRelease.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => {
            spawned++;
            return Effect.succeed(output);
          },
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => {
            requested++;
            return Effect.die("release lookup must not contact a registry");
          }),
        ),
      );
      const result = yield* service.get({ spec }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(spawned).toBe(0);
      expect(requested).toBe(0);
    }),
);
