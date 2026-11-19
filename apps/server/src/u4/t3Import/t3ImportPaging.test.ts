// @effect-diagnostics nodeBuiltinImport:off
// All rows live in an isolated synthetic SQLite database.
import * as NodeFSP from "node:fs/promises";
import { T3ImportError } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { buildMappedUnit } from "./T3ImportMappedUnit.ts";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createSource, sourceThread, sourceItem, FIXTURE_TIME } from "./testkit/T3SourceFixture.ts";
import { forEachSourcePage, SOURCE_TABLES, sourceTableName } from "./t3ImportPaging.ts";
import { ImportPageLimits, ImportLimits, IMPORT_LIMITS } from "./t3ImportPlan.ts";
import { readUnit, contentDigests, mapUnit, type StoredRow } from "./t3ImportRecords.ts";
import { sourceSummary, streamDigests, streamMapped } from "./t3ImportStreaming.ts";

const isImportError = Schema.is(T3ImportError);

it.effect("pages full tuples and oversized singletons without skipping or repeating records", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-import-pages-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const source = yield* createSource(directory, 96);
    const ledger = yield* source.sql<{
      readonly head: number;
    }>`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`;
    assert.strictEqual(ledger[0]?.head, 96);
    const members = ["thread:Z", "thread:a"];
    for (const thread of members) {
      yield* source.apply("thread.created", thread, sourceThread(thread));
      for (const [index, id] of ["same", "long".repeat(20_000), "z"].entries()) {
        yield* source.apply(
          "turn-item.updated",
          thread,
          sourceItem(thread + ":" + id, thread, {
            ordinal: index + 1,
            text: "whole payload ".repeat(index === 1 ? 100 : 1),
          }),
        );
        yield* source.sql`INSERT INTO mcp_app_model_context VALUES (${thread}, ${id}, 'server', 'tool', 'full context', ${FIXTURE_TIME})`;
      }
    }
    for (const table of SOURCE_TABLES) {
      const pages: Array<ReadonlyArray<StoredRow>> = [];
      yield* forEachSourcePage(source.sql, members, table, (rows) =>
        Effect.sync(() => {
          pages.push(rows);
        }),
      );
      const keys =
        table === "positions"
          ? "thread_id, turn_item_id"
          : table === "contexts"
            ? "thread_id, item_id"
            : undefined;
      const all = yield* source.sql.unsafe<StoredRow>(
        `SELECT * FROM "${sourceTableName(table)}" ORDER BY ${keys ?? (table === "threads" ? "thread_id" : table === "turn_items" ? "turn_item_id" : "rowid")}`,
      );
      assert.deepStrictEqual(pages.flat(), all);
      assert.ok(pages.every((page) => page.length <= 2));
    }
    yield* source.apply("node.updated", members[0]!, {
      id: "node:page",
      threadId: members[0],
      runId: null,
      parentNodeId: null,
      rootNodeId: "node:page",
      kind: "tool_call",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: FIXTURE_TIME,
    });
    yield* source.apply("subagent.updated", members[0]!, {
      id: "subagent:page",
      threadId: members[0],
      runId: null,
      parentNodeId: "node:page",
      origin: "provider_native",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: "thread:missing-informational",
      nativeTaskRef: null,
      prompt: "Synthetic task",
      title: null,
      model: null,
      status: "completed",
      result: "Preserved result",
      startedAt: FIXTURE_TIME,
      completedAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    });
    yield* source.sql`CREATE TEMP TABLE t3_import_oversized(thread_id TEXT)`;
    yield* source.sql`UPDATE mcp_app_model_context SET item_id = ${members[0]! + ":"} || item_id`;
    const whole = yield* readUnit(source.sql, members[0]!, members);
    assert.deepStrictEqual(
      whole.raw.get("turn_items")!.map((row) => row.inline_work_output),
      [0, 0, 0, 0, 0, 0],
    );
    const pre095Raw = new Map(whole.raw);
    pre095Raw.set(
      "turn_items",
      whole.raw
        .get("turn_items")!
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([column]) => column !== "inline_work_output"),
          ),
        ),
    );
    const pre095Digests = contentDigests({ ...whole, raw: pre095Raw }, new Map());
    const streamed = yield* streamDigests(
      source.sql,
      members[0]!,
      members,
      () => Effect.void,
      new Map(),
    );
    assert.deepStrictEqual(streamed, contentDigests(whole, new Map()));
    assert.deepStrictEqual(streamed, pre095Digests);
    assert.deepStrictEqual(contentDigests(whole, new Map()), pre095Digests);
    const originalPayload = whole.raw
      .get("turn_items")!
      .find((row) => row.turn_item_id === members[0]! + ":same")!.payload_json;
    yield* source.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.text', 'Changed history payload') WHERE turn_item_id = ${members[0]! + ":same"}`;
    const changedStreamed = yield* streamDigests(
      source.sql,
      members[0]!,
      members,
      () => Effect.void,
      new Map(),
    );
    const changedWhole = yield* readUnit(source.sql, members[0]!, members);
    assert.notStrictEqual(changedStreamed.digest, streamed.digest);
    assert.notStrictEqual(
      contentDigests(changedWhole, new Map()).digest,
      contentDigests(whole, new Map()).digest,
    );
    yield* source.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${originalPayload} WHERE turn_item_id = ${members[0]! + ":same"}`;
    const summary = yield* sourceSummary(source.sql, members);
    const counts = {
      ...summary.counts,
      orchestration_v2_projection_turn_items:
        summary.counts.orchestration_v2_projection_turn_items! + members.length,
      orchestration_v2_turn_item_positions:
        summary.counts.orchestration_v2_turn_item_positions! + members.length,
    };
    const key = ["synthetic", members[0]!, 1] as const;
    const mapping = {
      key,
      keys: new Map(members.map((member) => [member, key])),
      projects: new Map([["project:source", "project:target"]]),
      assets: new Map(),
      ownedTransferIds: new Set<string>(),
      importedAt: FIXTURE_TIME,
      unitDigest: streamed.digest,
      threadDigests: streamed.threadDigests,
      dependencies: [],
    };
    const baseline = mapUnit({
      ...mapping,
      unit: whole,
      owners: new Map(
        Object.values(whole.records)
          .flat()
          .map((record) => [String(record.value.id), String(record.row.thread_id)]),
      ),
    });
    const mapped: Array<ReturnType<typeof mapUnit>> = [];
    const result = yield* streamMapped(
      source.sql,
      source.sql,
      { ...mapping, ...summary, counts, root: members[0]!, members },
      (page) =>
        Effect.sync(() => {
          mapped.push(page);
        }),
    );
    assert.deepStrictEqual(
      result.counts,
      Object.fromEntries([...baseline.expected].map(([name, keys]) => [name, keys.length])),
    );
    assert.deepStrictEqual(
      mapped.flatMap((page) => page.events),
      baseline.events,
    );
    assert.deepStrictEqual(
      mapped.flatMap((page) => page.positions),
      baseline.positions,
    );
    assert.deepStrictEqual(
      mapped.flatMap((page) => page.contexts),
      baseline.contexts,
    );
    const appliedOrder = mapped.flatMap((page) => [
      ...page.positions.map(() => "position"),
      ...page.events.map((event) => event.type),
      ...page.contexts.map(() => "context"),
    ]);
    assert.ok(
      appliedOrder.lastIndexOf("thread.created") < appliedOrder.indexOf("position"),
      "all thread events precede every position in private apply order",
    );
    const staged = yield* Effect.acquireRelease(
      buildMappedUnit(
        source.sql,
        source.sql,
        directory,
        { ...mapping, ...summary, counts, root: members[0]!, members },
        () => Effect.void,
      ),
      (staged) => staged.dispose,
    );
    yield* Effect.promise(staged.verify);
    assert.deepStrictEqual(
      staged.created,
      baseline.events.filter((event) => event.type === "thread.created"),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = Context.get(
          yield* Layer.build(NodeSqliteClient.layer({ filename: staged.filename, readonly: true })),
          SqlClient.SqlClient,
        );
        assert.deepStrictEqual(
          yield* client`SELECT count FROM t3i_expected WHERE tbl = 'mcp_app_model_context'`.values,
          [[6]],
        );
      }),
    );
    yield* Effect.promise(staged.verify);
    for (const [name, maximum, limitName] of [
      ["source rows", summary.sourceRows, "rows"],
      ["source bytes", summary.sourceBytes, "unitBytes"],
      ["mapped rows", Object.values(result.counts).reduce((sum, count) => sum + count, 0), "rows"],
      ["mapped bytes", result.mappedBytes, "unitBytes"],
    ] as const) {
      const check = Effect.gen(function* () {
        if (name.startsWith("source")) yield* sourceSummary(source.sql, members);
        else
          yield* streamMapped(
            source.sql,
            source.sql,
            { ...mapping, ...summary, counts, root: members[0]!, members },
            () => Effect.void,
          );
      });
      yield* check.pipe(
        Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, [limitName]: maximum }),
      );
      const failed = yield* check.pipe(
        Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, [limitName]: maximum - 1 }),
        Effect.exit,
      );
      assert.equal(failed._tag, "Failure", name);
    }
    assert.equal(result.informationalLinks.length, 1);
    const linkCheck = streamMapped(
      source.sql,
      source.sql,
      { ...mapping, ...summary, counts, root: members[0]!, members },
      () => Effect.void,
    );
    yield* linkCheck.pipe(
      Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, informationalLinks: 1 }),
    );
    const excessLinks = yield* linkCheck.pipe(
      Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, informationalLinks: 0 }),
      Effect.exit,
    );
    assert.equal(excessLinks._tag, "Failure", "informational links cap+1 blocks");
    for (const maximum of [staged.storedBytes, staged.storedBytes - 1]) {
      const checked = yield* Effect.scoped(
        Effect.acquireRelease(
          buildMappedUnit(
            source.sql,
            source.sql,
            directory,
            { ...mapping, ...summary, counts, root: members[0]!, members },
            () => Effect.void,
          ),
          (unit) => unit.dispose,
        ),
      ).pipe(
        Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, unitBytes: maximum }),
        Effect.exit,
      );
      assert.equal(
        checked._tag,
        maximum === staged.storedBytes ? "Success" : "Failure",
        "stored bytes",
      );
    }
    yield* source.apply("node.updated", members[0]!, {
      id: "node:ambiguous",
      threadId: members[0],
      runId: null,
      parentNodeId: null,
      rootNodeId: "node:ambiguous",
      kind: "tool_call",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: FIXTURE_TIME,
    });
    yield* source.apply("thread.created", "thread:outside", sourceThread("thread:outside"));
    yield* source.apply("plan.updated", "thread:outside", {
      id: "node:ambiguous",
      threadId: "thread:outside",
      runId: null,
      nodeId: "node:outside",
      status: "completed",
      kind: "proposed_plan",
      markdown: "Unselected plan with an ambiguous local node ID",
    });
    const ambiguous = yield* streamMapped(
      source.sql,
      source.sql,
      { ...mapping, ...summary, counts, root: members[0]!, members },
      () => Effect.void,
    ).pipe(Effect.flip);
    assert.ok("stage" in ambiguous);
    assert.equal(ambiguous.stage, "ambiguous-reference-owner");
    const overLimit = yield* Effect.exit(
      forEachSourcePage(source.sql, members, "turn_items", () => Effect.void).pipe(
        Effect.provideService(ImportLimits, { ...IMPORT_LIMITS, rowBytes: 100 }),
      ),
    );
    assert.equal(overLimit._tag, "Failure");
    yield* source.sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (${members[0]}, ${members[0]! + ":same"}, 1)`;
    const malformedResults: Array<readonly [string, string | undefined, string | undefined]> = [];
    for (const invalidKey of [null, new Uint8Array([1, 2])]) {
      const rows = yield* source.sql<{
        rowid: number;
      }>`SELECT rowid FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${members[0]! + ":same"}`;
      const { rowid } = rows[0]!;
      yield* source.sql`UPDATE orchestration_v2_projection_turn_items SET turn_item_id = ${invalidKey} WHERE rowid = ${rowid}`;
      for (const metadataOnly of [false, true]) {
        const result = yield* forEachSourcePage(
          source.sql,
          members,
          "turn_items",
          () => Effect.void,
          metadataOnly,
        ).pipe(
          Effect.match({
            onFailure: (error) =>
              isImportError(error)
                ? ([error.reason, error.stage] as const)
                : ([undefined, undefined] as const),
            onSuccess: () => [undefined, undefined] as const,
          }),
        );
        malformedResults.push([
          `key ${invalidKey === null ? "null" : "blob"}, metadata ${metadataOnly}`,
          ...result,
        ]);
      }
      yield* source.sql`UPDATE orchestration_v2_projection_turn_items SET turn_item_id = ${members[0]! + ":same"} WHERE rowid = ${rowid}`;
    }
    for (const table of ["positions", "contexts"] as const) {
      if (table === "positions")
        yield* source.sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = -5 WHERE turn_item_id = ${members[0]! + ":same"}`;
      else yield* source.sql`UPDATE mcp_app_model_context SET tool = ${new Uint8Array([1, 2])}`;
      const result = yield* streamDigests(
        source.sql,
        members[0]!,
        members,
        () => Effect.void,
        new Map(),
      ).pipe(
        Effect.match({
          onFailure: (error) =>
            isImportError(error)
              ? ([error.reason, error.stage] as const)
              : ([undefined, undefined] as const),
          onSuccess: () => [undefined, undefined] as const,
        }),
      );
      malformedResults.push([table, ...result]);
      if (table === "positions")
        yield* source.sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = 1 WHERE turn_item_id = ${members[0]! + ":same"}`;
      else yield* source.sql`UPDATE mcp_app_model_context SET tool = 'tool'`;
    }
    assert.deepStrictEqual(malformedResults, [
      ["key null, metadata false", "unreadable-records", "turn_items.identity"],
      ["key null, metadata true", "unreadable-records", "turn_items.identity"],
      ["key blob, metadata false", "unreadable-records", "turn_items.identity"],
      ["key blob, metadata true", "unreadable-records", "turn_items.identity"],
      ["positions", "unreadable-records", "auxiliary-row"],
      ["contexts", "unreadable-records", "auxiliary-row"],
    ]);
  }).pipe(
    Effect.provideService(ImportPageLimits, {
      metadataRows: 2,
      metadataBytes: 64,
      payloadRows: 2,
      payloadBytes: 512,
    }),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
