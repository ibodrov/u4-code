import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import { HISTORICAL_ITEM_TYPES, type TurnStartHistoryIndexItem } from "./ProjectionStore.ts";
import { contextBoundaryOrdinal } from "./contextBoundary.ts";

function requiredHistory<T extends TurnStartHistoryIndexItem>(
  input: {
    readonly thread: OrchestrationV2AppThread;
    readonly run: OrchestrationV2Run;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly ownItems: ReadonlyArray<T>;
    readonly inheritedItems: ReadonlyArray<T>;
  },
  historical: (item: T) => boolean,
): ReadonlyArray<T> {
  const provenance = input.thread.importedFrom;
  if (!provenance || input.run.freshContext === true) return [];
  const boundary = contextBoundaryOrdinal({
    runs: input.runs.filter((r) => r.ordinal < input.run.ordinal),
    turnItems: input.ownItems,
  });
  if (boundary > provenance.lastRunOrdinal) return [];
  const ordinals = new Map(
    input.runs
      .filter(
        (run) =>
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "interrupted" ||
          (run.status === "cancelled" && run.startedAt !== null),
      )
      .map((run) => [run.id, run.ordinal]),
  );
  const visible = createOrchestrationV2TurnItemVisibility({ ...input, items: input.ownItems });
  const own = input.ownItems.filter(visible).filter((item) => {
    if (item.runId === null) return boundary === 0;
    const ordinal = ordinals.get(item.runId);
    return ordinal !== undefined && ordinal >= boundary && ordinal <= provenance.lastRunOrdinal;
  });
  return [...(boundary === 0 ? input.inheritedItems : []), ...own].filter(historical);
}

export function requiredImportedHistory(
  input: Parameters<typeof requiredHistory<OrchestrationV2TurnItem>>[0],
) {
  return requiredHistory(input, (item) => historicalMessage(item) !== null);
}
export function requiredImportedHistoryIds(
  input: Parameters<typeof requiredHistory<TurnStartHistoryIndexItem>>[0],
) {
  return requiredHistory(input, (item) =>
    (HISTORICAL_ITEM_TYPES as ReadonlyArray<string>).includes(item.type),
  );
}
