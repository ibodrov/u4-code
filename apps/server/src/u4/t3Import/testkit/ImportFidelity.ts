// @effect-diagnostics nodeBuiltinImport:off
// Independent scalar checksums distinguish preserved content from declared transformations.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import fields from "../t3ImportFields.json" with { type: "json" };
import { destinationId, type RecordTable, type UnitKey } from "../t3ImportPlan.ts";

const deliberate = new Set([
  "threads.limitRecovery",
  "threads.updatedAt",
  "runtime_requests.responseCapability",
  "context_handoffs.transferId",
  "runs.sourcePlanRef",
]);
export function verifyImportedRecord(
  table: RecordTable,
  source: Record<string, unknown>,
  stored: Record<string, unknown>,
  key: UnitKey,
  referenceKeys: Pick<ReadonlyMap<string, UnitKey>, "get"> = new Map(),
) {
  if (table === "threads") {
    const provenance = stored.importedFrom;
    NodeAssert.ok(
      typeof provenance === "object" &&
        provenance !== null &&
        "app" in provenance &&
        "environmentId" in provenance &&
        "threadId" in provenance &&
        "unitRootThreadId" in provenance &&
        "generation" in provenance &&
        "importedAt" in provenance,
    );
    NodeAssert.equal(provenance.app, "t3");
    NodeAssert.equal(provenance.environmentId, key[0]);
    NodeAssert.equal(provenance.threadId, source.id);
    NodeAssert.equal(provenance.unitRootThreadId, key[1]);
    NodeAssert.equal(provenance.generation, key[2]);
    NodeAssert.equal(stored.updatedAt, provenance.importedAt);
    if (stored.limitRecovery !== null && stored.limitRecovery !== undefined)
      NodeAssert.equal((stored.limitRecovery as { autoResume: unknown }).autoResume, false);
  }
  if (table === "runtime_requests")
    NodeAssert.deepEqual(stored.responseCapability, {
      type: "not_resumable",
      reason: "Imported from T3 Code.",
    });
  const checks: Array<{ path: string; classification: string; checksum: string }> = [];
  const walk = (before: unknown, after: unknown, path: string): void => {
    const classification = (fields[table] as Record<string, string>)[path];
    if (table === "threads" && path.startsWith("importedFrom")) return;
    if (deliberate.has(table + "." + path) || classification === "asset") return;
    if (["cleared", "native", "provenance"].includes(classification ?? "")) {
      if (
        path === "resolution.providerThreadRef" &&
        before !== null &&
        typeof before === "object" &&
        "driver" in before
      )
        NodeAssert.deepEqual(after, { driver: before.driver, nativeId: null, strength: "none" });
      else NodeAssert.ok(after === undefined || after === null, table + "." + path);
      return;
    }
    if (classification === "ref" || classification === "xref" || classification === "placeholder") {
      const expected = (id: string) =>
        classification === "placeholder"
          ? destinationId("placeholder:" + id, key)
          : destinationId(id, referenceKeys.get(id) ?? key);
      if (typeof before === "string") NodeAssert.equal(after, expected(before), table + "." + path);
      else if (Array.isArray(before))
        NodeAssert.deepEqual(
          after,
          before.map((id) => (typeof id === "string" ? expected(id) : id)),
          table + "." + path,
        );
      else NodeAssert.deepEqual(after, before, table + "." + path);
      return;
    }
    if (Array.isArray(before)) {
      NodeAssert.ok(Array.isArray(after), path);
      NodeAssert.equal(after.length, before.length, path);
      before.forEach((value, index) => walk(value, after[index], path + "[]"));
    } else if (before !== null && typeof before === "object" && classification !== "verbatim") {
      const object = after as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(before))
        walk(value, object?.[name], path ? path + "." + name : name);
    } else {
      NodeAssert.deepEqual(after, before, table + "." + path);
      checks.push({
        path,
        classification: classification ?? "container-leaf",
        checksum: NodeCrypto.createHash("sha256").update(JSON.stringify(before)).digest("hex"),
      });
    }
  };
  walk(source, stored, "");
  return { table, sourceId: source.id, checks };
}
