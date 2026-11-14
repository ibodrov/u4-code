// @effect-diagnostics nodeBuiltinImport:off -- Read the native fixture before the test runtime starts.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import { ompUsageFormat } from "./usage.ts";

const recording = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/simple-multiple-turns.json", import.meta.url), "utf8"),
) as { frame: { type?: string; command?: string; data?: { entries?: unknown[] } } }[];

describe("OMP native usage", () => {
  it("reads captured native usage and deduplicates preserved entries across forks", () => {
    const entries = recording.findLast((entry) => entry.frame.command === "get_entries")!.frame
      .data!.entries!;
    const state = ompUsageFormat.state!.initial();
    ompUsageFormat.parseLine('{"type":"session","id":"original"}', state);
    const records = entries.flatMap((entry) =>
      ompUsageFormat.parseLine(JSON.stringify(entry), state),
    );
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.provider)).toEqual(["oh-my-pi", "oh-my-pi"]);
    expect(records.reduce((total, record) => total + (record.reportedCostUsd ?? 0), 0)).toBeCloseTo(
      0.00086802,
      8,
    );
    const forkState = ompUsageFormat.state!.initial();
    ompUsageFormat.parseLine('{"type":"session","id":"fork"}', forkState);
    const forkRecords = entries.flatMap((entry) =>
      ompUsageFormat.parseLine(JSON.stringify(entry), forkState),
    );
    expect(forkRecords.map((record) => record.dedupeKey)).toEqual(
      records.map((record) => record.dedupeKey),
    );
    expect(ompUsageFormat.parseLine("invalid JSON", state)).toEqual([]);
  });
});
