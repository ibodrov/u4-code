import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
type BoundaryItem = Pick<OrchestrationV2TurnItem, "type"> & {
  readonly messageId?: string;
  readonly scheduledTaskId?: unknown;
};
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";

/** A fresh-session schedule run starts a side conversation; the thread's own one continues past it. */
export function isScheduledFreshRun(
  run: Pick<OrchestrationV2Run, "freshContext" | "userMessageId">,
  turnItems: ReadonlyArray<BoundaryItem>,
): boolean {
  // Turn items, unlike messages, are not narrowed to the runs since the latest compaction.
  return (
    run.freshContext === true &&
    turnItems.some(
      (item) =>
        item.type === "user_message" &&
        item.messageId === run.userMessageId &&
        item.scheduledTaskId !== undefined,
    )
  );
}

/** Ordinal of the latest started fresh-context run. Runs before it never reach a provider again. */
export function contextBoundaryOrdinal(projection: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<BoundaryItem>;
}): number {
  let boundary = 0;
  for (const run of projection.runs) {
    if (
      run.freshContext === true &&
      run.status !== "queued" &&
      !cancelledBeforeStart(run) &&
      run.ordinal > boundary &&
      !isScheduledFreshRun(run, projection.turnItems)
    ) {
      boundary = run.ordinal;
    }
  }
  return boundary;
}
