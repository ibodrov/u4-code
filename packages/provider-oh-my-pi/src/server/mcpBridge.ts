import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { OmpRpcError } from "./rpc.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  ompRecordField as field,
  ompRecordString as string,
  type OmpRpcConnection,
  type OmpRpcRecord,
} from "./rpc.ts";

const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeOmpMcpBridge = Effect.fn("OmpMcpBridge.make")(function* (
  connection: OmpRpcConnection,
  config: McpProviderSessionConfig | undefined,
) {
  const scope = yield* Effect.scope;
  const calls = new Map<string, Fiber.Fiber<void>>();
  const tools = new Map<string, string>();
  let sessionId: string | undefined;
  let nextId = 0;
  const client = yield* HttpClient.HttpClient;
  const request = Effect.fn("OmpMcpBridge.request")(function* (method: string, params: unknown) {
    if (!config) return yield* new OmpRpcError({ operation: "mcp_config" });
    const response = yield* client.execute(
      HttpClientRequest.post(config.endpoint).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: config.authorizationHeader,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        }),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: ++nextId, method, params }),
      ),
    );
    yield* HttpClientResponse.filterStatusOk(response);
    sessionId = response.headers["mcp-session-id"] ?? sessionId;
    const body = yield* response.text;
    return yield* Effect.try({
      try: () => {
        const data = response.headers["content-type"]?.includes("text/event-stream")
          ? body
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => decode(line.slice(5)))
              .find((value) => field(value, "id") !== undefined)
          : decode(body);
        if (field(data, "error")) throw new Error("MCP request failed");
        return field(data, "result");
      },
      catch: (cause) => new OmpRpcError({ operation: "mcp_response", cause }),
    });
  });
  if (config) {
    yield* Effect.gen(function* () {
      yield* request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "u4-omp", version: "1.0.0" },
      });
      const definitions: OmpRpcRecord[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const inventory = yield* request("tools/list", cursor ? { cursor } : {});
        const listed = field(inventory, "tools");
        if (!Array.isArray(listed)) return yield* new OmpRpcError({ operation: "mcp_inventory" });
        for (const tool of listed) {
          const name = string(tool, "name");
          if (!name) continue;
          const hostName = `u4_${name}`;
          tools.set(hostName, name);
          definitions.push({
            name: hostName,
            description: string(tool, "description") ?? name,
            parameters: field(tool, "inputSchema") ?? { type: "object", properties: {} },
            loadMode: "essential",
          });
        }
        cursor = string(inventory, "nextCursor");
        if (cursor && cursors.has(cursor))
          return yield* new OmpRpcError({ operation: "mcp_cursor" });
        if (cursor) cursors.add(cursor);
      } while (cursor);
      yield* connection.request({ type: "set_host_tools", tools: definitions });
    }).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.catchCause(() =>
        Effect.logWarning("oh-my-pi MCP tools unavailable; chat remains available"),
      ),
    );
  }
  return {
    handle: Effect.fn("OmpMcpBridge.handle")(function* (event: OmpRpcRecord) {
      if (event.type === "host_tool_cancel") {
        const id = string(event, "targetId");
        const fiber = id ? calls.get(id) : undefined;
        if (fiber) yield* Fiber.interrupt(fiber);
        return true;
      }
      if (event.type !== "host_tool_call") return false;
      const id = string(event, "id");
      const name = tools.get(string(event, "toolName") ?? "");
      if (!id) return true;
      const call = name
        ? request("tools/call", { name, arguments: event.arguments ?? {} })
        : Effect.fail(new OmpRpcError({ operation: "mcp_tool" }));
      const fiber = yield* Effect.uninterruptibleMask((restore) =>
        Effect.exit(restore(call)).pipe(
          Effect.flatMap((exit) =>
            connection.send(
              Exit.isSuccess(exit)
                ? {
                    type: "host_tool_result",
                    id,
                    result: { content: field(exit.value, "content") ?? [], details: exit.value },
                    isError: field(exit.value, "isError") === true,
                  }
                : {
                    type: "host_tool_result",
                    id,
                    result: {
                      content: [{ type: "text", text: "U4 MCP call failed or was cancelled" }],
                      details: {},
                    },
                    isError: true,
                  },
            ),
          ),
        ),
      ).pipe(
        Effect.ensuring(Effect.sync(() => calls.delete(id))),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      calls.set(id, fiber);
      return true;
    }),
  };
});
