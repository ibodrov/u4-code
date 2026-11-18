// @effect-diagnostics nodeBuiltinImport:off
// Synthetic fixtures exercise the real descriptor and SQLite paths.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as C from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../../persistence/Migrations.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";

const decodeDomainEvent = Schema.decodeUnknownEffect(C.OrchestrationV2DomainEventJson);
const encodeUpdatedAt = Schema.encodeEffect(Schema.DateTimeUtcFromString);
export const FIXTURE_TIME = "2026-10-01T00:00:00.000Z";
export const sourceThread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "project:source",
  createdBy: "user",
  creationSource: "web",
  title: id,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "old-branch",
  worktreePath: "/source/worktree",
  activeProviderThreadId: "provider-thread:source",
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...extra,
});
export const sourceItem = (id: string, threadId: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  type: "assistant_message",
  messageId: "message:" + id,
  text: "history " + id,
  streaming: false,
  ...extra,
});
export const sourceRun = (id: string, threadId: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId,
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "test" },
  providerThreadId: "provider-thread:source",
  userMessageId: "message:user:" + id,
  rootNodeId: "node:" + id,
  activeAttemptId: null,
  status: "completed",
  requestedAt: FIXTURE_TIME,
  startedAt: FIXTURE_TIME,
  completedAt: FIXTURE_TIME,
  checkpointId: "checkpoint:" + id,
  contextHandoffId: null,
  ...extra,
});
export const createSource = Effect.fn("T3SourceFixture.create")(function* (
  directory: string,
  head = 89,
) {
  const home = NodePath.join(directory, "source"),
    userdata = NodePath.join(home, "userdata");
  yield* Effect.promise(() =>
    NodeFSP.mkdir(NodePath.join(userdata, "attachments"), { recursive: true, mode: 0o700 }),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(userdata, "environment-id"), "environment:synthetic-t3", {
      mode: 0o600,
    }),
  );
  const dbPath = NodePath.join(userdata, "statev2.sqlite");
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename: dbPath }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* runMigrations({ toMigrationInclusive: head }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  const store = Context.get(
    yield* Layer.build(
      ProjectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
    ),
    ProjectionStore.ProjectionStoreV2,
  );
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project:source', 'Synthetic project', ${directory}, '[]', ${FIXTURE_TIME}, ${FIXTURE_TIME})`;
  const apply = Effect.fn("T3SourceFixture.apply")(function* (
    type: C.OrchestrationV2DomainEvent["type"],
    threadId: string,
    payload: unknown,
  ) {
    const event = yield* decodeDomainEvent({
      id:
        "fixture:" +
        type +
        ":" +
        String(typeof payload === "object" && payload && "id" in payload ? payload.id : "event"),
      type,
      threadId,
      occurredAt: FIXTURE_TIME,
      payload,
    });
    // Migration 95 added a derived column to the current projection writer.
    if (head < 95 && event.type === "turn-item.updated") {
      const payloadJson = yield* ProjectionStore.encodeTurnItemPayload(event.payload);
      const updatedAt = yield* encodeUpdatedAt(event.payload.updatedAt);
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          node_id,
          provider_thread_id,
          provider_turn_id,
          parent_item_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        )
        VALUES (
          ${event.payload.id},
          ${event.payload.threadId},
          ${event.payload.runId},
          ${event.payload.nodeId},
          ${event.payload.providerThreadId},
          ${event.payload.providerTurnId},
          ${event.payload.parentItemId},
          ${event.payload.ordinal},
          ${event.payload.type},
          ${event.payload.status},
          ${updatedAt},
          ${payloadJson}
        )
        ON CONFLICT(turn_item_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          node_id = excluded.node_id,
          provider_thread_id = excluded.provider_thread_id,
          provider_turn_id = excluded.provider_turn_id,
          parent_item_id = excluded.parent_item_id,
          ordinal = excluded.ordinal,
          type = excluded.type,
          status = excluded.status,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `;
      return;
    }
    yield* store.apply(event);
  });
  return { home, userdata, dbPath, sql, store, apply, directory };
});
