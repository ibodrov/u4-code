// @effect-diagnostics nodeBuiltinImport:off
// Every byte is generated in the caller's private benchmark home.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as C from "@t3tools/contracts";
import {
  sourceThread,
  sourceRun,
  sourceItem,
  FIXTURE_TIME,
  type createSource,
} from "./T3SourceFixture.ts";
import {
  RECORD_TABLES,
  PROJECTION_PREFIX,
  rowBytesSql,
  quoteIdentifier,
  digest,
  type RecordTable,
} from "../t3ImportPlan.ts";
import { encodeJson } from "../t3ImportFieldMap.ts";
import { TABLE_KEYS } from "../t3ImportRecords.ts";

export interface CorpusShape {
  readonly name: string;
  readonly idLength?: number;
  readonly members: number;
  readonly sourceRows: number;
  readonly sourceColumnBytes: number;
  readonly maxRowBytes: number;
  readonly incidentTransfers: number;
  readonly assetReferences: number;
  readonly assetReferencedBytes: number;
  readonly tables: Readonly<
    Record<string, { readonly rows: number; readonly columnBytes: number }>
  >;
}
const prefix: Record<RecordTable, string> = {
  threads: "thread",
  runs: "run",
  run_attempts: "attempt",
  nodes: "node",
  subagents: "subagent",
  provider_turns: "provider-turn",
  runtime_requests: "request",
  messages: "message",
  plans: "plan",
  turn_items: "item",
  context_handoffs: "handoff",
  context_transfers: "transfer",
};
function corpusIdentity(shape: CorpusShape, tag: string) {
  const count = (table: RecordTable) =>
    table === "context_transfers" ? shape.incidentTransfers : (shape.tables[table]?.rows ?? 0);
  const id = (table: RecordTable, index: number) => {
    const stem = prefix[table] + ":" + tag + ":" + index;
    const length =
      shape.idLength ??
      (table === "turn_items"
        ? Math.max(
            48,
            Math.floor(
              (shape.tables.turn_item_positions?.columnBytes ?? 0) /
                Math.max(1, count("turn_items")),
            ) - 78,
          )
        : 70);
    return stem.padEnd(length, "x");
  };
  const rootRuns = Math.max(1, Math.floor(count("runs") * 0.65));
  const owner = (run: number) =>
    shape.members === 1 || run < rootRuns ? 0 : 1 + ((run - rootRuns) % (shape.members - 1));
  const ordinal = (run: number) =>
    owner(run) === 0 ? run + 1 : 1 + Math.floor((run - rootRuns) / (shape.members - 1));
  return {
    id,
    count,
    owner,
    ordinal,
    root: id("threads", 0),
    members: Array.from({ length: shape.members }, (_, index) => id("threads", index)),
  };
}
export const generateCorpusUnit = Effect.fn("ImportBench.generateUnit")(function* (
  source: Effect.Success<ReturnType<typeof createSource>>,
  shape: CorpusShape,
  tag: string,
) {
  const identity = corpusIdentity(shape, tag);
  const { id, count, owner, ordinal, members, root } = identity;
  // Shared native identity padding preserves setup byte budgets without changing related references.
  const providerThreadId = ("provider-thread:synthetic:" + tag).padEnd(
    Math.ceil(
      Math.max(
        (shape.tables.runs?.columnBytes ?? 0) / Math.max(1, count("runs")),
        (shape.tables.run_attempts?.columnBytes ?? 0) / Math.max(1, count("run_attempts")),
      ) / 2,
    ),
    "z",
  );
  let setupTransactions = 0;
  const projectId = "project:synthetic:" + tag;
  const workspaceRoot = NodePath.join(source.directory, "workspace-" + tag);
  yield* Effect.promise(() => NodeFSP.mkdir(workspaceRoot, { mode: 0o700 }));
  yield* source.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},${"Synthetic " + tag},${workspaceRoot},'[]',${FIXTURE_TIME},${FIXTURE_TIME})`;

  const assets: Array<{ sourceId: string; sha256: string; sidecarSha256: string | null }> = [];
  const attachments: Array<{
    type: "file";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];
  for (let index = 0; index < shape.assetReferences; index++) {
    const hash = digest(tag + ":" + index);
    const sourceId = `legacy-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}-pdf`;
    const bytes = Buffer.alloc(
      Math.max(64, Math.ceil(shape.assetReferencedBytes / Math.max(1, shape.assetReferences))),
      65 + (index % 26),
    );
    const sidecar = Buffer.from("Synthetic extracted sidecar é 工具 " + index);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(source.userdata, "attachments", sourceId + ".pdf"), bytes, {
        mode: 0o600,
      }),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(source.userdata, "attachments", sourceId + ".pdf.txt"),
        sidecar,
        { mode: 0o600 },
      ),
    );
    assets.push({ sourceId, sha256: digest(bytes), sidecarSha256: digest(sidecar) });
    attachments.push({
      type: "file",
      id: sourceId,
      name: "synthetic.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
  }
  const attachmentAt = new Map<number, typeof attachments>();
  const rootRuns = Math.max(1, Math.floor(count("runs") * 0.65));
  for (const [index, attachment] of attachments.entries()) {
    const message =
      shape.members > 1 && index > 0 && count("runs") > rootRuns
        ? rootRuns +
          Math.floor(
            ((index - 1) * (count("runs") - rootRuns)) / Math.max(1, attachments.length - 1),
          )
        : index;
    const list = attachmentAt.get(message) ?? [];
    list.push(attachment);
    attachmentAt.set(message, list);
  }
  const childCount = shape.members - 1;
  const terminalChildren = Math.min(childCount, Math.max(0, count("runs") - rootRuns));
  if (count("context_transfers") < childCount + terminalChildren)
    throw new Error("Synthetic transfer budget cannot cover child spawns and terminal results");
  const sourceTotals: Record<string, { rows: number; bytes: number; maximum: number }> = {};
  for (const table of RECORD_TABLES) {
    const name = PROJECTION_PREFIX + table;
    const columns = yield* source.sql<{
      name: string;
    }>`SELECT name FROM pragma_table_xinfo(${name}) WHERE hidden = 0`;
    const bytes = rowBytesSql(columns.map((column) => column.name));
    const reported =
      shape.tables[table]?.columnBytes ??
      (table === "context_transfers"
        ? shape.sourceColumnBytes -
          Object.values(shape.tables).reduce((sum, table) => sum + table.columnBytes, 0)
        : 0);
    for (let start = 0; start < count(table); start += 256) {
      yield* source.sql.withTransaction(
        Effect.gen(function* () {
          for (let index = start; index < Math.min(start + 256, count(table)); index++) {
            const run = index % Math.max(1, count("runs"));
            const thread = members[table === "threads" ? index : owner(run)]!;
            const node = id("nodes", run);
            let value: Record<string, unknown>;
            let event: C.OrchestrationV2DomainEvent["type"];
            let multiplier = 1;
            let pad: (extra: string) => void;
            if (table === "threads") {
              value = sourceThread(thread, {
                projectId,
                activeProviderThreadId: providerThreadId,
                title: "Synthetic " + tag + " " + index,
                ...(index
                  ? {
                      lineage: {
                        rootThreadId: root,
                        parentThreadId: root,
                        relationshipToParent: "subagent",
                      },
                      forkedFrom: { type: "node", threadId: root, nodeId: id("nodes", 0) },
                    }
                  : {}),
              });
              event = "thread.created";
              multiplier = 2;
              pad = (extra) => {
                value.title = String(value.title) + extra;
              };
            } else if (table === "runs") {
              value = sourceRun(id(table, index), thread, {
                ordinal: ordinal(index),
                providerThreadId,
                rootNodeId: id("nodes", index),
                activeAttemptId: id("run_attempts", index),
                userMessageId: id("messages", index % Math.max(1, count("messages"))),
              });
              event = "run.created";
              multiplier = 2;
              pad = (extra) => {
                value.providerThreadId = String(value.providerThreadId) + extra;
              };
            } else if (table === "run_attempts") {
              value = {
                id: id(table, index),
                runId: id("runs", run),
                attemptOrdinal: 1,
                rootNodeId: node,
                providerInstanceId: "codex",
                providerThreadId,
                providerTurnId: null,
                reason: "initial",
                status: "completed",
                startedAt: FIXTURE_TIME,
                completedAt: FIXTURE_TIME,
              };
              event = "run-attempt.created";
              multiplier = 2;
              pad = (extra) => {
                value.providerThreadId = String(value.providerThreadId) + extra;
              };
            } else if (table === "nodes") {
              value = {
                id: id(table, index),
                threadId: thread,
                runId: id("runs", run),
                parentNodeId: null,
                rootNodeId: node,
                kind: index < count("runs") ? "root_turn" : "tool_call",
                status: "completed",
                countsForRun: true,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: { driver: "codex", nativeId: "synthetic", strength: "strong" },
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: FIXTURE_TIME,
                completedAt: FIXTURE_TIME,
              };
              event = "node.updated";
              pad = (extra) => {
                value.nativeItemRef = {
                  driver: "codex",
                  nativeId: "synthetic" + extra,
                  strength: "strong",
                };
              };
            } else if (table === "subagents") {
              value = {
                id: id(table, index),
                threadId: thread,
                runId: id("runs", run),
                parentNodeId: node,
                origin: "provider_native",
                createdBy: "agent",
                driver: "codex",
                providerInstanceId: "codex",
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Synthetic task é 工具",
                title: null,
                model: null,
                status: "completed",
                result: "Full synthetic result",
                startedAt: FIXTURE_TIME,
                completedAt: FIXTURE_TIME,
                updatedAt: FIXTURE_TIME,
              };
              event = "subagent.updated";
              pad = (extra) => {
                value.prompt = String(value.prompt) + extra;
              };
            } else if (table === "provider_turns") {
              value = {
                id: id(table, index),
                providerThreadId,
                nodeId: node,
                runAttemptId: id("run_attempts", run),
                nativeTurnRef: { driver: "codex", nativeId: "synthetic", strength: "strong" },
                ordinal: index + 1,
                status: "completed",
                startedAt: FIXTURE_TIME,
                completedAt: FIXTURE_TIME,
              };
              event = "provider-turn.updated";
              pad = (extra) => {
                value.nativeTurnRef = {
                  driver: "codex",
                  nativeId: "synthetic" + extra,
                  strength: "strong",
                };
              };
            } else if (table === "runtime_requests") {
              value = {
                id: id(table, index),
                nodeId: node,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "resolved",
                responseCapability: { type: "message" },
                feedback: "Synthetic resolved input",
                createdAt: FIXTURE_TIME,
                resolvedAt: FIXTURE_TIME,
              };
              event = "runtime-request.updated";
              pad = (extra) => {
                value.feedback = String(value.feedback) + extra;
              };
            } else if (table === "messages") {
              value = {
                id: id(table, index),
                threadId: thread,
                runId: id("runs", run),
                nodeId: node,
                createdBy: "user",
                creationSource: "web",
                role: index % 4 ? "assistant" : "user",
                text: "Synthetic conversation é 工具 " + index,
                attachments: attachmentAt.get(index) ?? [],
                streaming: false,
                createdAt: FIXTURE_TIME,
                updatedAt: FIXTURE_TIME,
              };
              event = "message.updated";
              pad = (extra) => {
                value.text = String(value.text) + extra;
              };
            } else if (table === "plans") {
              value = {
                id: id(table, index),
                threadId: thread,
                runId: id("runs", run),
                nodeId: node,
                status: "completed",
                kind: "proposed_plan",
                markdown: "Complete synthetic plan",
              };
              event = "plan.updated";
              pad = (extra) => {
                value.markdown = String(value.markdown) + extra;
              };
            } else if (table === "turn_items") {
              const {
                text: _text,
                messageId: _message,
                streaming: _streaming,
                ...base
              } = sourceItem(id(table, index), thread, {
                runId: id("runs", run),
                nodeId: node,
                ordinal: ordinal(run) * 1_000_000 + index + 1,
              });
              const kind = index % 100;
              if (kind < 35) {
                value = {
                  ...base,
                  type: "command_execution",
                  input: "synthetic-command",
                  output: "Full synthetic output é 工具",
                  exitCode: 0,
                };
                pad = (extra) => {
                  value.output = String(value.output) + extra;
                };
              } else if (kind < 46) {
                value = {
                  ...base,
                  type: "dynamic_tool",
                  toolName: "synthetic_tool",
                  input: {
                    literalIds: [id("nodes", index % Math.max(1, count("nodes")))],
                    dense: Array.from({ length: 128 }, (_, i) => ({ index: i, value: "é" })),
                  },
                  output: { text: "Complete synthetic result" },
                };
                pad = (extra) => {
                  value.output = { text: "Complete synthetic result" + extra };
                };
              } else if (kind < 75) {
                value = {
                  ...base,
                  type: "reasoning",
                  text: "Complete synthetic reasoning",
                  streaming: false,
                };
                pad = (extra) => {
                  value.text = String(value.text) + extra;
                };
              } else if (kind < 87) {
                value = {
                  ...base,
                  type: "assistant_message",
                  messageId: id("messages", index % Math.max(1, count("messages"))),
                  text: "The synthetic release marker is saffron.",
                  streaming: false,
                };
                pad = (extra) => {
                  value.text = String(value.text) + extra;
                };
              } else if (kind < 90) {
                value = {
                  ...base,
                  type: "user_message",
                  messageId: id("messages", index % Math.max(1, count("messages"))),
                  createdBy: "user",
                  creationSource: "web",
                  inputIntent: "turn_start",
                  text: "Synthetic request",
                  attachments: [],
                };
                pad = (extra) => {
                  value.text = String(value.text) + extra;
                };
              } else if (kind < 94) {
                value = {
                  ...base,
                  type: "file_change",
                  fileName: "synthetic.txt",
                  diffStr: "Complete synthetic diff",
                };
                pad = (extra) => {
                  value.diffStr = String(value.diffStr) + extra;
                };
              } else if (kind < 97) {
                value = {
                  ...base,
                  type: "checkpoint",
                  checkpointId: "checkpoint:synthetic",
                  scopeId: "scope:synthetic",
                  files: [],
                };
                pad = (extra) => {
                  value.checkpointId = String(value.checkpointId) + extra;
                };
              } else {
                value = {
                  ...base,
                  type: "system_notice",
                  message: "Synthetic complete stored notice",
                };
                pad = (extra) => {
                  value.message = String(value.message) + extra;
                };
              }
              event = "turn-item.updated";
            } else if (table === "context_handoffs") {
              value = {
                id: id(table, index),
                threadId: thread,
                targetRunId: id("runs", run),
                fromProviderThreadIds: [],
                toProviderThreadId: providerThreadId,
                coveredRunOrdinals: { from: 1, to: Math.max(1, ordinal(run)) },
                strategy: "full_thread_summary",
                status: "ready",
                summaryMessageId: null,
                summaryText: "Complete historical synthetic handoff",
                createdByProviderInstanceId: null,
                createdAt: FIXTURE_TIME,
                updatedAt: FIXTURE_TIME,
              };
              event = "context-handoff.updated";
              pad = (extra) => {
                value.summaryText = String(value.summaryText) + extra;
              };
            } else {
              const result =
                terminalChildren > 0 &&
                (index < terminalChildren || index >= terminalChildren + childCount);
              const child = result
                ? 1 +
                  ((index < terminalChildren ? index : index - terminalChildren - childCount) %
                    terminalChildren)
                : childCount
                  ? 1 + ((index - terminalChildren) % childCount)
                  : 0;
              const firstChildRun = rootRuns + child - 1;
              const latestChildRun =
                firstChildRun +
                Math.floor((count("runs") - 1 - firstChildRun) / Math.max(1, childCount)) *
                  childCount;
              const transferSource = result ? members[child]! : root;
              value = {
                id: id(table, index),
                type: result ? "subagent_result" : "subagent_spawn",
                sourceThreadId: transferSource,
                targetThreadId: result ? root : members[child],
                sourcePoint: {
                  threadId: transferSource,
                  runId: id("runs", result ? latestChildRun : 0),
                },
                basePoint: null,
                sourceProviderInstanceId: "codex",
                targetProviderInstanceId: "codex",
                targetRunId: null,
                status: "consumed",
                resolution: null,
                createdBy: "agent",
                error: "Synthetic historical transfer",
                createdAt: FIXTURE_TIME,
                updatedAt: FIXTURE_TIME,
                consumedAt: FIXTURE_TIME,
              };
              event = "context-transfer.created";
              pad = (extra) => {
                value.error = String(value.error) + extra;
              };
            }
            yield* source.apply(event, thread, value);
            if (table === "turn_items")
              yield* source.sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id,turn_item_id,ordinal) VALUES (${thread},${String(value.id)},${Number(value.ordinal)})`;
            const size = yield* source.sql.unsafe<{ bytes: number }>(
              `SELECT ${bytes} AS bytes FROM ${quoteIdentifier(name)} WHERE ${quoteIdentifier(TABLE_KEYS[table])} = ?`,
              [String(value.id)],
            );
            const target =
              table === "turn_items" && index === 0
                ? Math.max(shape.maxRowBytes, Math.ceil(reported / Math.max(1, count(table))))
                : Math.ceil(reported / Math.max(1, count(table)));
            const extra = Math.max(0, Math.ceil((target - size[0]!.bytes) / multiplier));
            if (extra) {
              pad("z".repeat(extra));
              yield* source.apply(event, thread, value);
            }
          }
        }),
      );
      setupTransactions++;
      yield* Effect.yieldNow;
    }
    const totals = yield* source.sql.unsafe<{ rows: number; bytes: number; maximum: number }>(
      `SELECT COUNT(*) AS rows,COALESCE(SUM(${bytes}),0) AS bytes,COALESCE(MAX(${bytes}),0) AS maximum FROM ${quoteIdentifier(name)} WHERE ${table === "context_transfers" ? "source_thread_id" : "thread_id"} IN (SELECT value FROM json_each(?))`,
      [encodeJson(members)],
    );
    sourceTotals[table] = totals[0]!;
  }
  const positionColumns = yield* source.sql<{
    name: string;
  }>`SELECT name FROM pragma_table_xinfo('orchestration_v2_turn_item_positions') WHERE hidden = 0`;
  const positions = yield* source.sql.unsafe<{ rows: number; bytes: number; maximum: number }>(
    `SELECT COUNT(*) AS rows,SUM(${rowBytesSql(positionColumns.map((column) => column.name))}) AS bytes,MAX(${rowBytesSql(positionColumns.map((column) => column.name))}) AS maximum FROM orchestration_v2_turn_item_positions WHERE thread_id IN (SELECT value FROM json_each(?))`,
    [encodeJson(members)],
  );
  sourceTotals.positions = positions[0]!;
  const rows = Object.values(sourceTotals).reduce((sum, table) => sum + table.rows, 0);
  const bytes = Object.values(sourceTotals).reduce((sum, table) => sum + table.bytes, 0);
  if (rows !== shape.sourceRows || bytes < shape.sourceColumnBytes)
    throw new Error(
      "Synthetic fixture did not reproduce required source rows/bytes: " +
        tag +
        " " +
        rows +
        " " +
        bytes,
    );
  return {
    ...identity,
    shape,
    tag,
    projectId,
    providerThreadId,
    setupTransactions,
    workspaceRoot,
    sourceTotals,
    sourceRows: rows,
    sourceBytes: bytes,
    assets,
  };
});
