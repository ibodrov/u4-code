import * as Contracts from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

import fields from "./t3ImportFields.json" with { type: "json" };
import type { RecordTable } from "./t3ImportPlan.ts";

export const RECORD_SCHEMAS = {
  threads: Contracts.OrchestrationV2AppThreadJson,
  runs: Contracts.OrchestrationV2RunJson,
  run_attempts: Contracts.OrchestrationV2RunAttemptJson,
  nodes: Contracts.OrchestrationV2ExecutionNodeJson,
  subagents: Contracts.OrchestrationV2SubagentJson,
  provider_turns: Contracts.OrchestrationV2ProviderTurnJson,
  runtime_requests: Contracts.OrchestrationV2RuntimeRequestJson,
  messages: Contracts.OrchestrationV2ConversationMessageJson,
  plans: Contracts.OrchestrationV2PlanArtifact,
  turn_items: Contracts.OrchestrationV2TurnItemJson,
  context_handoffs: Contracts.OrchestrationV2ContextHandoffJson,
  context_transfers: Contracts.OrchestrationV2ContextTransferJson,
} as const;
export const AUXILIARY_SCHEMAS = {
  positions: Schema.Struct({
    thread_id: Schema.String,
    turn_item_id: Schema.String,
    ordinal: Contracts.NonNegativeInt,
  }),
  contexts: Schema.Struct({
    thread_id: Schema.String,
    item_id: Schema.String,
    server: Schema.String,
    tool: Schema.String,
    text: Schema.String,
    updated_at: Schema.String,
  }),
} as const;
export const auxiliaryFieldMap = {
  positions: { thread_id: "ref", turn_item_id: "ref", ordinal: "kept" },
  contexts: {
    thread_id: "ref",
    item_id: "xref",
    server: "kept",
    tool: "kept",
    text: "verbatim",
    updated_at: "kept",
  },
} as const;
const recordCodecs = Object.fromEntries(
  Object.entries(RECORD_SCHEMAS).map(([table, schema]) => [
    table,
    { decode: Schema.decodeUnknownSync(schema), encode: Schema.encodeUnknownSync(schema) },
  ]),
);
export type FieldClass =
  | "ref"
  | "xref"
  | "placeholder"
  | "native"
  | "cleared"
  | "kept"
  | "verbatim"
  | "provenance"
  | "asset";
export const fieldMap: Readonly<Record<RecordTable, Readonly<Record<string, string>>>> = fields;

export function schemaPaths(
  ast: AST.AST,
  path = "",
  paths = new Set<string>(),
): ReadonlyArray<string> {
  const encoded = AST.toEncoded(ast);
  if (AST.isObjects(encoded)) {
    for (const property of encoded.propertySignatures) {
      const name = path ? `${path}.${String(property.name)}` : String(property.name);
      paths.add(name);
      schemaPaths(property.type, name, paths);
    }
    if (encoded.indexSignatures.length) paths.add(path + ".*");
  } else if (AST.isUnion(encoded)) {
    for (const type of encoded.types) schemaPaths(type, path, paths);
  } else if (AST.isArrays(encoded)) {
    for (const type of encoded.rest) schemaPaths(type, path + "[]", paths);
    for (const element of encoded.elements) schemaPaths(element, path + "[]", paths);
  }
  return [...paths].sort();
}
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const wireOnly = new Set([
  "textOmitted",
  "filesOmitted",
  "promptOmitted",
  "resultOmitted",
  "outputOmitted",
]);
const requiredNulls: Readonly<Record<string, ReadonlySet<string>>> = {
  threads: new Set(["branch", "worktreePath", "activeProviderThreadId", "lastVisitedAt"]),
  runs: new Set(["checkpointId"]),
  nodes: new Set(["checkpointScopeId", "nativeItemRef"]),
  subagents: new Set(["nativeTaskRef"]),
  provider_turns: new Set(["nativeTurnRef"]),
  runtime_requests: new Set(["nativeRequestRef"]),
  turn_items: new Set(["nativeItemRef"]),
};

export function readRecord(table: RecordTable, raw: string): Record<string, unknown> {
  const original: unknown = JSON.parse(raw);
  if (!isObject(original))
    throw new Contracts.T3ImportError({ reason: "unreadable-records", stage: table });
  const codec = recordCodecs[table]!;
  const decoded = codec.decode(original);
  const encoded = codec.encode(decoded);
  const losses: string[] = [];
  const compare = (before: unknown, after: unknown, path: string) => {
    const fieldClass = fieldMap[table][path];
    if (fieldClass === "cleared" || fieldClass === "verbatim" || fieldClass === "provenance")
      return;
    if (Array.isArray(before)) {
      if (!Array.isArray(after) || before.length !== after.length) {
        losses.push(path);
        return;
      }
      before.forEach((v, i) => compare(v, after[i], path + "[]"));
      return;
    }
    if (isObject(before)) {
      for (const [key, value] of Object.entries(before)) {
        if (wireOnly.has(key)) {
          losses.push(path ? `${path}.${key}` : key);
          continue;
        }
        compare(value, isObject(after) ? after[key] : undefined, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (before === after) return;
    if (
      typeof before === "string" &&
      typeof after === "string" &&
      /^\d{4}-\d\d-\d\dT/.test(before) &&
      Number.isFinite(Date.parse(before)) &&
      Date.parse(before) === Date.parse(after)
    )
      return;
    losses.push(path);
  };
  compare(original, encoded, "");
  if (losses.length)
    throw new Contracts.T3ImportError({
      reason: "unreadable-records",
      stage: `${table}.${losses[0]}`.slice(0, 160),
      actual: losses.length,
    });
  return encoded as Record<string, unknown>;
}

export function transformRecord(
  table: RecordTable,
  record: Record<string, unknown>,
  mapId: (
    id: string,
    classification: FieldClass,
    path: string,
    sourceThreadId?: string,
  ) => string | null,
) {
  let exclusions = 0;
  const visit = (value: unknown, path: string, hint?: string): unknown => {
    const classification = fieldMap[table][path] as FieldClass | undefined;
    if (
      classification === "provenance" ||
      classification === "cleared" ||
      classification === "native"
    ) {
      if (value != null) exclusions++;
      if (path === "responseCapability")
        return { type: "not_resumable", reason: "Imported from T3 Code." };
      if (path === "resolution.providerThreadRef" && isObject(value))
        return { driver: value.driver, nativeId: null, strength: "none" };
      return requiredNulls[table]?.has(path) ? null : undefined;
    }
    if (classification === "verbatim" || classification === "asset") return value;
    if (Array.isArray(value))
      return value.map((v) =>
        typeof v === "string" &&
        (classification === "ref" || classification === "xref" || classification === "placeholder")
          ? mapId(v, classification, path, hint)
          : visit(v, path + "[]", hint),
      );
    if (isObject(value)) {
      const threadHint = typeof value.threadId === "string" ? value.threadId : hint;
      return Object.fromEntries(
        Object.entries(value).flatMap(([k, v]) => {
          const mapped = visit(v, path ? `${path}.${k}` : k, threadHint);
          return mapped === undefined ? [] : [[k, mapped]];
        }),
      );
    }
    return typeof value === "string" &&
      (classification === "ref" || classification === "xref" || classification === "placeholder")
      ? mapId(value, classification, path, hint)
      : value;
  };
  return {
    record: visit(
      record,
      "",
      typeof record.threadId === "string" ? record.threadId : undefined,
    ) as Record<string, unknown>,
    exclusions,
  };
}
