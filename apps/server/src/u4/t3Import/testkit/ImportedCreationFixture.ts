import { sourceThread, FIXTURE_TIME } from "./T3SourceFixture.ts";
import { readRecord } from "../t3ImportFieldMap.ts";
import { mapUnit, type MaterializedUnit } from "../t3ImportRecords.ts";
import { RECORD_TABLES } from "../t3ImportPlan.ts";

export function importedCreationFixture(id: string) {
  const thread = sourceThread(id);
  const records = Object.fromEntries(
    RECORD_TABLES.map((table) => [table, []]),
  ) as unknown as MaterializedUnit["records"];
  const unit: MaterializedUnit = {
    rootId: id,
    memberIds: [id],
    records: {
      ...records,
      threads: [{ row: { thread_id: id }, value: readRecord("threads", JSON.stringify(thread)) }],
    },
    positions: [],
    contexts: [],
    raw: new Map(),
  };
  const mapped = mapUnit({
    unit,
    key: ["synthetic-source", id, 1],
    keys: new Map([[id, ["synthetic-source", id, 1] as const]]),
    owners: new Map([[id, id]]),
    projects: new Map([["project:source", "project:destination"]]),
    assets: new Map(),
    ownedTransferIds: new Set(),
    importedAt: FIXTURE_TIME,
    unitDigest: "synthetic",
    threadDigests: new Map([[id, "synthetic"]]),
    dependencies: [],
  });
  const event = mapped.events.find((event) => event.type === "thread.created");
  if (!event) throw new Error("Importer did not produce its thread creation event");
  return event;
}
