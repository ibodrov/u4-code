import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  auxiliaryFieldMap,
  AUXILIARY_SCHEMAS,
  fieldMap,
  RECORD_SCHEMAS,
  readRecord,
  schemaPaths,
  transformRecord,
} from "./t3ImportFieldMap.ts";
import { destinationId, isImportedRecordId, RECORD_TABLES } from "./t3ImportPlan.ts";
import { sourceThread, sourceItem } from "./testkit/T3SourceFixture.ts";

const decodeThread = Schema.decodeUnknownSync(C.OrchestrationV2AppThreadJson);

it("classifies every current stored schema path explicitly", () => {
  for (const table of RECORD_TABLES)
    assert.deepStrictEqual(
      Object.keys(fieldMap[table]).sort(),
      schemaPaths(RECORD_SCHEMAS[table].ast),
      table,
    );
  for (const table of ["positions", "contexts"] as const)
    assert.deepStrictEqual(
      Object.keys(auxiliaryFieldMap[table]).sort(),
      schemaPaths(AUXILIARY_SCHEMAS[table].ast),
      table,
    );
});
it("blocks nested losses and stored wire markers while retaining unknown tool I/O verbatim", () => {
  const raw: Record<string, unknown> = sourceItem("item:a", "thread:a", {
    type: "dynamic_tool",
    toolName: "example",
    input: { arbitrary: { sourceThreadId: "literal" } },
    output: { untouched: true },
  });
  delete raw.messageId;
  delete raw.text;
  delete raw.streaming;
  const record = readRecord("turn_items", JSON.stringify(raw));
  const mapped = transformRecord("turn_items", record, (id) =>
    destinationId(id, ["source", "thread:a", 1]),
  ).record;
  assert.deepStrictEqual(mapped.input, raw.input);
  assert.deepStrictEqual(mapped.output, raw.output);
  for (const bad of [
    { ...raw, extra: { nested: true } },
    { ...raw, type: "future-kind" },
    { ...raw, outputOmitted: true },
    {
      ...raw,
      nativeItemRef: {
        driver: "codex",
        nativeId: "source-native",
        strength: "strong",
        unexpected: true,
      },
    },
  ])
    assert.throws(() => readRecord("turn_items", JSON.stringify(bad)));
  assert.doesNotThrow(() =>
    readRecord(
      "threads",
      JSON.stringify(sourceThread("thread:a", { createdAt: "2026-10-01T00:00:00+00:00" })),
    ),
  );
});
it("keeps provenance across the stored JSON codec and removes native runtime fields without rewriting history", () => {
  const provenance = {
    app: "t3" as const,
    environmentId: C.EnvironmentId.make("source-environment"),
    threadId: C.ThreadId.make("thread:a"),
    unitRootThreadId: C.ThreadId.make("thread:a"),
    generation: 2,
    importedAt: DateTime.makeUnsafe("2026-11-16T00:00:00Z"),
    sourceDigest: "source-digest",
    unitDigest: "unit-digest",
    dependencyKey: "dependency-key",
    dependencies: [],
    importedRowCounts: { transfers: 1 },
    ownedTransferIds: [
      C.ContextTransferId.make(destinationId("transfer:t", ["source-environment", "thread:a", 2])),
    ],
    lastRunOrdinal: 3,
  };
  const thread = decodeThread(sourceThread("thread:a"));
  const codec = Schema.fromJsonString(C.OrchestrationV2AppThreadJson);
  const encoded = Schema.encodeSync(codec)({ ...thread, importedFrom: provenance });
  assert.deepStrictEqual(Schema.decodeSync(codec)(encoded).importedFrom, provenance);
  const mapped = transformRecord(
    "threads",
    readRecord("threads", JSON.stringify(sourceThread("thread:a"))),
    (id) => destinationId(id, ["source-environment", "thread:a", 2]),
  ).record;
  assert.strictEqual(mapped.branch, null);
  assert.strictEqual(mapped.worktreePath, null);
  assert.strictEqual(mapped.activeProviderThreadId, null);
  assert.strictEqual(mapped.title, "thread:a");
  for (const source of ["thread:a", "async-answer:42", "question?", "Thread with spaces"])
    assert.ok(isImportedRecordId(destinationId(source, ["source", "thread:a", 1])));
  for (const id of [
    "thread:a",
    "limit-resume:thread:t3i:aaaaaaaaaaaaaaaaaaaaaaaaaa:x",
    "node:thread%3At3i%3Aaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "thread:t3i:aaaaaaaaaaaaaaaaaaaaaaaaaa:extra",
  ])
    assert.ok(!isImportedRecordId(id));
});
