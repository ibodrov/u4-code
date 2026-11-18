import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeOmpMcpBridge } from "./mcpBridge.ts";
import { OmpRpcError, type OmpRpcConnection, type OmpRpcRecord } from "./rpc.ts";

const config = {
  environmentId: EnvironmentId.make("env"),
  providerInstanceId: ProviderInstanceId.make("omp"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  endpoint: "http://localhost/mcp",
  authorizationHeader: "Bearer private-test-token",
  browserToolsAvailable: false,
};

describe("OMP host tools", () => {
  it.effect(
    "keeps credentials in the host and returns MCP failures and cancellation as tool results",
    () =>
      Effect.gen(function* () {
        const sent = yield* Queue.unbounded<OmpRpcRecord>();
        const cancelled = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let n = 0;
        const client = HttpClient.make((request) => {
          const ordinal = ++n;
          if (ordinal > 3)
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                jsonrpc: "2.0",
                id: ordinal,
                result:
                  ordinal === 2
                    ? {
                        tools: [
                          {
                            name: "test",
                            description: "test",
                            inputSchema: { type: "object", properties: {} },
                          },
                        ],
                      }
                    : ordinal === 3
                      ? { isError: true, content: [{ type: "text", text: "service unavailable" }] }
                      : {},
              }),
            ),
          );
        });
        const rpc: OmpRpcConnection = {
          events: yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>(),
          exited: Effect.never,
          terminate: Effect.void,
          send: (record) => Queue.offer(sent, record).pipe(Effect.asVoid),
          request: (record) => Queue.offer(sent, record).pipe(Effect.as({})),
        };
        const bridge = yield* makeOmpMcpBridge(rpc, config).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const registration = yield* Queue.take(sent);
        assert.equal(registration.type, "set_host_tools");
        assert.notInclude(JSON.stringify(registration), "private-test-token");
        yield* bridge.handle({
          type: "host_tool_call",
          id: "first",
          toolName: "u4_test",
          arguments: {},
        });
        const failure = yield* Queue.take(sent);
        assert.equal(failure.isError, true);
        assert.equal(failure.id, "first");
        yield* bridge.handle({
          type: "host_tool_call",
          id: "second",
          toolName: "u4_test",
          arguments: {},
        });
        yield* Deferred.await(started);
        yield* bridge.handle({ type: "host_tool_cancel", targetId: "second" });
        yield* Deferred.await(cancelled);
        const cancellation = yield* Queue.take(sent);
        assert.equal(cancellation.id, "second");
        assert.equal(cancellation.isError, true);
        assert.isFalse(yield* bridge.handle({ type: "message_update" }));
      }).pipe(Effect.scoped),
  );
});
