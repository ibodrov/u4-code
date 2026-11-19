import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const T3ImportSessionId = TrimmedNonEmptyString.pipe(Schema.brand("T3ImportSessionId"));
export type T3ImportSessionId = typeof T3ImportSessionId.Type;
export const T3ImportJobId = TrimmedNonEmptyString.pipe(Schema.brand("T3ImportJobId"));
export type T3ImportJobId = typeof T3ImportJobId.Type;
export const T3ImportPlanId = TrimmedNonEmptyString.pipe(Schema.brand("T3ImportPlanId"));
export type T3ImportPlanId = typeof T3ImportPlanId.Type;

export class T3ImportError extends Schema.TaggedError<T3ImportError>()("T3ImportError", {
  reason: Schema.Literals([
    "source-not-found",
    "no-v2-database",
    "newer-schema",
    "older-schema",
    "divergent-ledger",
    "divergent-schema",
    "pending-v1-threads",
    "same-environment",
    "no-environment-id",
    "source-changed",
    "too-large",
    "insufficient-space",
    "unsafe-source",
    "unsupported-platform",
    "staging-failed",
    "session-not-found",
    "job-not-found",
    "not-ready",
    "plan-changed",
    "busy",
    "pending-work",
    "unreadable-records",
    "invalid-lineage",
    "ancestor-blocked",
    "dependency-changed",
    "destination-conflict",
    "attachment-conflict",
    "asset-reference-unsupported",
    "would-start-work",
    "policy-refused",
    "unknown",
    "cancelled",
  ]),
  stage: Schema.optional(Schema.String.check(Schema.isMaxLength(160))),
  actual: Schema.optional(NonNegativeInt),
  maximum: Schema.optional(NonNegativeInt),
  cause: Schema.optional(Schema.Defect()),
}) {
  static forClient(error: T3ImportError): T3ImportError {
    return new T3ImportError({
      reason: error.reason,
      ...(error.stage === undefined ? {} : { stage: error.stage }),
      ...(error.actual === undefined ? {} : { actual: error.actual }),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    });
  }
  override get message(): string {
    const limit =
      this.actual !== undefined && this.maximum !== undefined
        ? `: ${this.actual} exceeds the limit of ${this.maximum}`
        : "";
    return `T3 Code import: ${this.reason}${this.stage ? ` (${this.stage})` : ""}${limit}.`;
  }
}

export const T3ImportSelection = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(300)),
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(100)),
  excludeThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(300)),
  newCopyUnitRootIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
  projectMapping: Schema.Array(
    Schema.Struct({
      sourceProjectId: ProjectId,
      destination: Schema.Union([
        Schema.Struct({ type: Schema.Literal("existing"), projectId: ProjectId }),
        Schema.Struct({ type: Schema.Literal("create") }),
      ]),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type T3ImportSelection = typeof T3ImportSelection.Type;

const Cursor = Schema.optional(Schema.String.check(Schema.isMaxLength(256)));
export const T3ImportProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: NonNegativeInt,
});
export const T3ImportThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archived: Schema.Boolean,
  itemCount: NonNegativeInt,
  runCount: NonNegativeInt,
});
export const T3ImportSection = Schema.Literals([
  "threads",
  "dependencies",
  "mappings",
  "skipped",
  "blocked",
  "exclusions",
  "warnings",
  "unavailable-links",
]);
export type T3ImportSection = typeof T3ImportSection.Type;
export const T3ImportRow = Schema.Struct({
  id: Schema.optional(Schema.String),
  sourceThreadId: Schema.optional(ThreadId),
  destinationThreadId: Schema.optional(ThreadId),
  unitRootThreadId: Schema.optional(ThreadId),
  title: Schema.optional(Schema.String),
  category: Schema.String,
  explanation: Schema.String,
  count: Schema.optional(NonNegativeInt),
  generation: Schema.optional(NonNegativeInt),
});
export type T3ImportRow = typeof T3ImportRow.Type;
const Rows = Schema.Array(T3ImportRow).check(Schema.isMaxLength(100));
export const T3ImportPage = Schema.Struct({ rows: Rows, nextCursor: Schema.NullOr(Schema.String) });
export type T3ImportPage = typeof T3ImportPage.Type;
export const T3ImportPreview = Schema.Struct({
  planId: T3ImportPlanId,
  totals: Schema.Record(Schema.String, NonNegativeInt),
  sections: Schema.Record(
    T3ImportSection,
    Schema.Struct({ ...T3ImportPage.fields, count: NonNegativeInt }),
  ),
});
export type T3ImportPreview = typeof T3ImportPreview.Type;
export const T3ImportSession = Schema.Struct({
  sessionId: T3ImportSessionId,
  status: Schema.Literals(["preparing", "ready", "failed"]),
  source: Schema.optional(
    Schema.Struct({
      home: Schema.String,
      environmentId: EnvironmentId,
      schemaHead: NonNegativeInt,
    }),
  ),
  projects: Schema.Array(T3ImportProject).check(Schema.isMaxLength(100)),
  nextProjectCursor: Schema.NullOr(Schema.String),
  error: Schema.optional(T3ImportError),
});
export type T3ImportSession = typeof T3ImportSession.Type;
export const T3ImportJobStatus = Schema.Literals([
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "unknown",
]);
export const T3ImportResult = Schema.Struct({
  sourceThreadId: ThreadId,
  destinationThreadId: Schema.optional(ThreadId),
  outcome: Schema.Literals([
    "imported",
    "skipped",
    "blocked",
    "failed",
    "dependency-failed",
    "not-started",
  ]),
  reason: Schema.String,
  unavailableLinks: NonNegativeInt,
});
export type T3ImportResult = typeof T3ImportResult.Type;
export const T3ImportJob = Schema.Struct({
  jobId: T3ImportJobId,
  status: T3ImportJobStatus,
  progress: Schema.Struct({ completed: NonNegativeInt, total: NonNegativeInt }),
  results: Schema.Array(T3ImportResult).check(Schema.isMaxLength(100)),
  unavailableLinkRows: Rows,
  nextCursor: Schema.NullOr(Schema.String),
});
export type T3ImportJob = typeof T3ImportJob.Type;
export const T3ImportInputs = {
  open: Schema.Struct({
    sourceHome: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  }),
  getSession: Schema.Struct({
    sessionId: Schema.optional(T3ImportSessionId),
    projectCursor: Cursor,
  }),
  listThreads: Schema.Struct({
    sessionId: T3ImportSessionId,
    sourceProjectId: ProjectId,
    cursor: Cursor,
    query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  preview: Schema.Struct({ sessionId: T3ImportSessionId, selection: T3ImportSelection }),
  previewPage: Schema.Struct({
    planId: T3ImportPlanId,
    section: T3ImportSection,
    cursor: Schema.String.check(Schema.isMaxLength(256)),
  }),
  start: Schema.Struct({ sessionId: T3ImportSessionId, planId: T3ImportPlanId }),
  getJob: Schema.Struct({ jobId: Schema.optional(T3ImportJobId), cursor: Cursor }),
  cancel: Schema.Struct({ jobId: T3ImportJobId }),
  close: Schema.Struct({ sessionId: T3ImportSessionId }),
};
export const T3ImportOutputs = {
  open: Schema.Struct({ sessionId: T3ImportSessionId }),
  getSession: T3ImportSession,
  listThreads: Schema.Struct({
    threads: Schema.Array(T3ImportThread).check(Schema.isMaxLength(100)),
    nextCursor: Schema.NullOr(Schema.String),
  }),
  preview: T3ImportPreview,
  previewPage: T3ImportPage,
  start: Schema.Struct({ jobId: T3ImportJobId }),
  getJob: T3ImportJob,
  cancel: Schema.Struct({ status: T3ImportJobStatus }),
  close: Schema.Struct({}),
};
