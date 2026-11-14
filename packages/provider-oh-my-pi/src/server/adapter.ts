import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { makeOmpMcpBridge } from "./mcpBridge.ts";
import * as NodeUtil from "node:util";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import * as Predicate from "effect/Predicate";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type MessageId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  isOmpHostOwnedCommand,
  parseOmpCompactCommand,
  type OmpCompactCommand,
} from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  findReportedOmpModel,
  makeOmpRpcConnection,
  resolveOmpModelSlug,
  ompRecordField as recordField,
  ompRecordNumber as recordNumber,
  ompRecordString as recordString,
  type OmpRpcConnection,
  type OmpRpcRecord,
} from "./rpc.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
const OMP_FILE_CHANGE_TOOLS = ["edit", "write"];

export const OMP_PROVIDER = ProviderDriverKind.make("oh-my-pi");
const OMP_DRIVER_KIND = OMP_PROVIDER;
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

const OMP_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;
const OMP_REQUEST_TIMEOUT_MS = 15_000;
const OMP_SESSION_TIMEOUT_MS = 60_000;
const MAX_EXTENSION_STATUSES = 32;
const MAX_EXTENSION_STATUS_KEY_LENGTH = 256;
const MAX_EXTENSION_STATUS_TEXT_LENGTH = 4096;
const OMP_UNSOLICITED_ACTIVITY_ERROR =
  "Omp started agent work outside an active U4 turn. The session was stopped to prevent invisible tool execution.";

const OmpProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

const MAX_STRUCTURED_TOOL_OUTPUT_BYTES = 64 * 1024;

function isBoundedStructuredToolValue(value: unknown): boolean {
  let bytes = MAX_STRUCTURED_TOOL_OUTPUT_BYTES;
  let nodes = 4_096;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32 || --nodes < 0 || bytes < 0) return false;
    if (Array.isArray(entry)) {
      bytes -= 2 + entry.length;
      return entry.every((item) => visit(item, depth + 1));
    }
    if (Predicate.isObject(entry)) {
      bytes -= 2;
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key.length > bytes) return false;
        bytes -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (!visit(entry[key], depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (typeof entry === "string" && entry.length > bytes) return false;
    bytes -= Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8");
    return bytes >= 0;
  };
  return visit(value, 0);
}

function ompToolOutput(result: unknown, toolName: string): unknown {
  const rawContent = recordField(result, "content");
  const content = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  let structured = recordField(result, "structuredContent");
  const details = recordField(result, "details");
  const isMcpResult =
    toolName.startsWith("mcp__") &&
    recordString(details, "server") !== undefined &&
    recordString(details, "tool") !== undefined &&
    Array.isArray(recordField(structured, "content"));
  if (isMcpResult) {
    structured = recordField(structured, "structuredContent");
  }
  if (typeof structured === "string" && structured === contentText(content)) {
    structured = undefined;
  }
  if (toolName === "read" && Predicate.isObject(structured)) {
    const image = readToolOutputImage(structured);
    const note =
      recordString(
        content.find((block) => recordField(block, "type") === "text"),
        "text",
      ) ?? "";
    if (
      image !== null &&
      Object.keys(structured).every((key) => ["type", "data", "mimeType", "note"].includes(key)) &&
      recordString(structured, "note") === note &&
      content.some((block) => {
        const match = readToolOutputImage(block);
        return match !== null && match.mimeType === image.mimeType && match.data === image.data;
      })
    ) {
      structured = undefined;
    }
  }
  if (structured !== undefined && !isBoundedStructuredToolValue(structured)) {
    return {
      content: [
        ...content,
        {
          type: "text",
          text: "Structured output omitted because it exceeds the stored result limit.",
        },
      ],
    };
  }
  if (
    !isMcpResult &&
    structured === undefined &&
    content.every((block) => recordField(block, "type") === "text")
  ) {
    const text = contentText(content);
    return text.length > 0 ? text : undefined;
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: OMP_PROVIDER, nativeId, strength };
}

interface OmpStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

type OmpCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface OmpCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface OmpProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: OmpCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

interface ActiveOmpTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, OmpStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolNames: Map<string, string>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  interrupted: boolean;
  nativeAborted: boolean;
  sawAgentActivity: boolean;
  adoptedWake: boolean;
  promptMayBeCommandOnly: boolean;
  latestCompactionAfterTokens: number | null;
  lastLiveUsedTokens: number | null;
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Omp emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  manualCompactInFlight: boolean;
  activeCompaction: OmpCompactionState | null;
  activeProviderRetry: OmpProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Steers Omp queued in send order; it reads them at a step boundary, after running tools return. */
  readonly unreadSteers: Array<MessageId>;
  stopTreeRefs?: OmpTurnTreeRefs | null;
  /** The provider/model Omp reported on its latest assistant message. */
  reportedModel?: string;
}

interface OmpTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

interface PendingOmpPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

function ompApprovalRequestKind(title: string): "command" | "file-change" {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (OMP_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file-change"
    : "command";
}

interface OmpPromptSend {
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly kind: "turn_start" | "steer";
  readonly record: OmpRpcRecord;
  readonly messageId?: MessageId;
}

interface OmpThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveOmpTurn | null;
}

interface OmpWake {
  readonly state: OmpThreadState;
  readonly events: Array<OmpRpcRecord>;
}

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { continuationRequests } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OMP_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(function () {
      return Effect.succeed(OmpProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("OmpAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const scope = yield* Effect.scope;
        const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
        const mcpSession = yield* mcpSessions.read(input.threadId);
        const sessionDir = path.join(
          host.paths.stateDir,
          "oh-my-pi",
          encodeURIComponent(options.instanceId),
          "sessions",
        );
        yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
        const resolvedLaunchArgs = resolveOmpLaunchArgs(options.settings.launchArgs);
        if (!resolvedLaunchArgs.ok) {
          return yield* protocolError(resolvedLaunchArgs.message);
        }
        const launch = buildOmpRpcLaunch({
          launchArgs: resolvedLaunchArgs.args,
          environment: options.environment,
          sessionDir,
          runtimeMode: input.runtimePolicy.runtimeMode,
        });
        const scopedLaunch = yield* agentScope.wrap({
          command: options.settings.binaryPath || "omp",
          args: launch.args,
          name: "omp",
          threadId: input.threadId,
          env: launch.env,
        });
        const scopeUnit = scopedLaunch.unit;
        const stopScope =
          scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
        yield* Effect.addFinalizer(() => stopScope);
        const connection: OmpRpcConnection = yield* makeOmpRpcConnection({
          command: scopedLaunch.command,
          args: scopedLaunch.args,
          cwd,
          env: launch.env,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
        if (scopeUnit !== undefined) {
          yield* connection.exited.pipe(
            Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
            Effect.forkIn(scope),
          );
        }
        const now = yield* DateTime.now;
        let sessionEntity: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: OMP_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities: OmpProviderCapabilitiesV2,
          extensionStatuses: [],
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          ProviderAdapter.ProviderAdapterV2Error | Cause.Done
        >();
        const pendingPrompts = new Map<string, PendingOmpPrompt>();
        const sessionEventPermit = yield* Semaphore.make(1);
        let threadState: OmpThreadState | null = null;
        let registrationAttempted = false;
        let failedNativeResume = false;
        let lastNativeThreadId: string | null = null;
        let stopRequested = false;
        let unsolicitedActivityDetected = false;
        let runtimeRetired = false;
        let pendingWake: OmpWake | null = null;
        let nativeBackgroundWork = false;
        const nativeChildren = new Map<
          string,
          { turn: ActiveOmpTurn; entity: OrchestrationV2Subagent; index: number | undefined }
        >();
        const promptOwners = new Map<string, OmpPromptSend>();
        let extensionStatusReset: {
          previous: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;
          readonly touched: Set<string>;
          readonly ready: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
        } | null = null;
        let rollbackBarrier: Deferred.Deferred<
          void,
          ProviderAdapter.ProviderAdapterProtocolError
        > | null = null;
        let pendingPromptResponsesDrained: Deferred.Deferred<
          void,
          ProviderAdapter.ProviderAdapterProtocolError
        > | null = null;
        let closed = false;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true;
            sessionEntity = { ...sessionEntity, extensionStatuses: [] };
            pendingWake = null;
            if (pendingPromptResponsesDrained !== null)
              yield* Deferred.fail(
                pendingPromptResponsesDrained,
                protocolError("Omp session closed while awaiting prompt acknowledgment"),
              );
            if (extensionStatusReset !== null)
              yield* Deferred.fail(
                extensionStatusReset.ready,
                protocolError("Omp session closed during status reset"),
              );
            if (rollbackBarrier !== null)
              yield* Deferred.fail(
                rollbackBarrier,
                protocolError("Omp session closed during rollback"),
              );
          }),
        );
        let appliedModel: string | null = null;
        let selectionInitialized = false;
        let appliedThinking: string | null = null;

        let appliedSessionName: string | null = null;
        const outOfTurnExtensionErrors: Array<OmpRpcRecord> = [];
        let lastKnownLeaf: string | null = null;
        let leafCursorStale = false;
        let baselineModel: { provider: string; modelId: string } | null = null;
        let baselineThinking: string | null = null;
        let contextWindow: number | null = null;
        const modelContextWindows = new Map<string, number>();
        let discoveredModels: ReadonlyArray<unknown> | null = null;
        let nextPromptId = 0;
        const pendingPromptResponses: Array<OmpPromptSend & { readonly id: string }> = [];
        const pendingCompactResponses: Array<{
          readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
          readonly kind: "turn_start" | "steer";
        }> = [];
        let nativeCompacting = false;
        const heldPrompts: Array<OmpPromptSend> = [];

        const sendPrompt = Effect.fnUntraced(function* (prompt: OmpPromptSend) {
          if (nativeCompacting) {
            heldPrompts.push(prompt);
            return;
          }
          const id = `u4-omp-prompt-${nextPromptId++}`;
          pendingPromptResponsesDrained ??= yield* Deferred.make<
            void,
            ProviderAdapter.ProviderAdapterProtocolError
          >();
          pendingPromptResponses.push({ ...prompt, id });
          promptOwners.set(id, prompt);
          const turn = threadState?.activeTurn;
          if (
            prompt.kind === "steer" &&
            prompt.messageId !== undefined &&
            turn?.providerTurn.id === prompt.providerTurnId
          ) {
            turn.unreadSteers.push(prompt.messageId);
            yield* emitSteerStatus(turn, prompt.messageId, "pending");
          }
          yield* connection.send({ ...prompt.record, id });
        });
        let releasedPromptTurnId: OrchestrationV2ProviderTurn["id"] | null = null;

        const compactRpcRecord = (command: OmpCompactCommand): OmpRpcRecord =>
          command.customInstructions === undefined
            ? { type: "compact" }
            : { type: "compact", customInstructions: command.customInstructions };

        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const emitSteerStatus = (
          turn: ActiveOmpTurn,
          messageId: MessageId,
          status: "pending" | "completed" | "cancelled",
        ) =>
          emit({
            type: "steer.updated",
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            messageId,
            status,
          });

        const updateProviderSession =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (
            status: OrchestrationV2ProviderSession["status"],
            lastError: string | null = sessionEntity.lastError,
          ) {
            const updatedAt = yield* DateTime.now;
            sessionEntity = {
              ...sessionEntity,
              status,
              lastError,
              updatedAt,
              ...(status === "stopped" || runtimeRetired || unsolicitedActivityDetected
                ? { extensionStatuses: [] }
                : {}),
            };
            yield* emit({
              type: "provider_session.updated",
              driver: OMP_PROVIDER,
              providerSession: sessionEntity,
            });
          });

        const updateExtensionStatus = Effect.fnUntraced(function* (event: OmpRpcRecord) {
          if (
            closed ||
            stopRequested ||
            runtimeRetired ||
            unsolicitedActivityDetected ||
            sessionEntity.status === "stopped"
          )
            return;
          const key = recordString(event, "statusKey");
          const rawText = recordField(event, "statusText");
          if (
            key === undefined ||
            key.trim().length === 0 ||
            key.length > MAX_EXTENSION_STATUS_KEY_LENGTH ||
            (rawText !== undefined && typeof rawText !== "string")
          )
            return;
          const text =
            typeof rawText === "string"
              ? NodeUtil.stripVTControlCharacters(
                  rawText.slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH * 4),
                )
                  .replaceAll(/\p{Cc}/gu, " ")
                  .trim()
                  .slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH)
              : "";
          const statuses = sessionEntity.extensionStatuses ?? [];
          if (extensionStatusReset?.previous.some((status) => status.key === key)) {
            extensionStatusReset.touched.add(key);
          }
          const index = statuses.findIndex((status) => status.key === key);
          if (
            index < 0
              ? text.length === 0 || statuses.length >= MAX_EXTENSION_STATUSES
              : statuses[index]?.text === text
          )
            return;
          sessionEntity = {
            ...sessionEntity,
            extensionStatuses:
              text.length === 0
                ? statuses.filter((status) => status.key !== key)
                : index < 0
                  ? [...statuses, { key, text }]
                  : statuses.map((status) => (status.key === key ? { key, text } : status)),
          };
          yield* updateProviderSession(sessionEntity.status);
        });

        const clearExtensionStatuses = Effect.fn("OmpAdapter.clearExtensionStatuses")(function* () {
          if (sessionEntity.extensionStatuses?.length === 0) return;
          sessionEntity = { ...sessionEntity, extensionStatuses: [] };
          yield* updateProviderSession(sessionEntity.status);
        });

        const updateProviderThread =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (
            state: OmpThreadState,
            patch: Partial<OrchestrationV2ProviderThread>,
            retainedNativeTurnIds?: ReadonlyArray<string>,
          ) {
            const updatedAt = yield* DateTime.now;
            state.providerThread = { ...state.providerThread, ...patch, updatedAt };
            yield* emit({
              type: "provider_thread.updated",
              driver: OMP_PROVIDER,
              providerThread: state.providerThread,
              pendingBackgroundWork: nativeBackgroundWork || pendingWake !== null,
              ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
            });
          });

        const itemOrdinal = (turn: ActiveOmpTurn, nativeItemId: string): number => {
          const existing = turn.itemOrdinals.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = turn.nextItemOrdinal++;
          turn.itemOrdinals.set(nativeItemId, ordinal);
          return ordinal;
        };

        const request = (record: OmpRpcRecord, timeoutMs = OMP_REQUEST_TIMEOUT_MS) =>
          connection.request(record, timeoutMs);

        const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
          const value = recordNumber(input, key);
          return value === undefined ? undefined : Math.max(0, Math.trunc(value));
        };

        const rememberModelContextWindow = (model: unknown): number | null => {
          const provider = recordString(model, "provider");
          const id = recordString(model, "id");
          const capacity = nonNegativeInteger(model, "contextWindow");
          if (
            provider !== undefined &&
            id !== undefined &&
            capacity !== undefined &&
            capacity > 0
          ) {
            modelContextWindows.set(`${provider}/${id}`, capacity);
            return capacity;
          }
          return null;
        };

        const lifecycleRequest = Effect.fn("OmpAdapter.lifecycleRequest")(
          function* (record: OmpRpcRecord) {
            if (extensionStatusReset !== null)
              return yield* protocolError("A Omp session lifecycle request is already pending");
            const reset = {
              previous: sessionEntity.extensionStatuses ?? [],
              touched: new Set<string>(),
              ready: yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>(),
            };
            extensionStatusReset = reset;
            return yield* Effect.gen(function* () {
              if (
                !(yield* Queue.offer(connection.events, {
                  type: "u4.extension_status_reset",
                  reset,
                }))
              )
                return yield* protocolError("Omp transport closed during status reset");
              yield* Deferred.await(reset.ready);
              const result = yield* request(record, OMP_SESSION_TIMEOUT_MS);
              if (recordField(result, "cancelled") === true) {
                yield* sessionEventPermit.withPermits(1)(
                  Effect.gen(function* () {
                    if (closed || stopRequested) return;
                    const current = sessionEntity.extensionStatuses ?? [];
                    const restored = reset.previous.flatMap((status) => {
                      if (!reset.touched.has(status.key)) return [status];
                      const updated = current.find((candidate) => candidate.key === status.key);
                      return updated === undefined ? [] : [updated];
                    });
                    restored.push(
                      ...current.filter(
                        (status) => !reset.previous.some((previous) => previous.key === status.key),
                      ),
                    );
                    const statuses = restored.slice(0, MAX_EXTENSION_STATUSES);
                    if (
                      statuses.length === current.length &&
                      statuses.every(
                        (status, index) =>
                          status.key === current[index]?.key &&
                          status.text === current[index]?.text,
                      )
                    )
                      return;
                    sessionEntity = { ...sessionEntity, extensionStatuses: statuses };
                    yield* updateProviderSession(sessionEntity.status);
                  }),
                );
              }
              return result;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (extensionStatusReset === reset) extensionStatusReset = null;
                }),
              ),
            );
          },
          (effect, record) =>
            effect.pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Omp session lifecycle request failed", {
                  providerSessionId: input.providerSessionId,
                  operation: record["type"],
                  errorTag: error._tag,
                }),
              ),
              Effect.tapError((error) =>
                error._tag === "OmpRpcError" || error._tag === "OmpRpcTimeoutError"
                  ? connection.terminate
                  : Effect.void,
              ),
              Effect.onInterrupt(() => connection.terminate),
            ),
        );

        const tokenUsageFromStats = (
          stats: unknown,
          fallbackUsedTokens: number | null,
          updatedAt: DateTime.Utc,
        ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
          const contextUsage = recordField(stats, "contextUsage");
          const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
          const usedTokens =
            nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
          if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
            return undefined;

          const totals = recordField(stats, "tokens");
          const inputTokens = nonNegativeInteger(totals, "input");
          const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
          const outputTokens = nonNegativeInteger(totals, "output");
          return {
            usedTokens,
            maxTokens,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            updatedAt: DateTime.formatIso(updatedAt),
          };
        };

        const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
          request({ type: "get_session_stats" }, 2_000).pipe(
            Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
            Effect.orElseSucceed(() => undefined),
          );

        /**
         * Omp attaches the current message's cumulative usage to every streaming update (0.84.2+).
         */
        const reportLiveUsage =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (turn: ActiveOmpTurn, usage: unknown) {
            const usedTokens = nonNegativeInteger(usage, "totalTokens");
            if (
              usedTokens === undefined ||
              usedTokens === 0 ||
              usedTokens === turn.lastLiveUsedTokens ||
              contextWindow === null ||
              contextWindow === 0
            ) {
              return;
            }
            turn.lastLiveUsedTokens = usedTokens;
            const inputTokens = nonNegativeInteger(usage, "input");
            const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
            const outputTokens = nonNegativeInteger(usage, "output");
            const updatedAt = yield* DateTime.now;
            yield* emit({
              type: "provider_turn.updated",
              driver: OMP_PROVIDER,
              threadId: turn.turnInput.threadId,
              providerTurn: {
                ...turn.providerTurn,
                tokenUsage: {
                  usedTokens,
                  maxTokens: contextWindow,
                  ...(inputTokens === undefined ? {} : { inputTokens }),
                  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                  ...(outputTokens === undefined ? {} : { outputTokens }),
                  updatedAt: DateTime.formatIso(updatedAt),
                },
              },
            });
          });

        const baseItemFields = (
          turn: ActiveOmpTurn,
          nativeItemId: string,
          startedAt: DateTime.Utc,
          updatedAt: DateTime.Utc,
          parentNativeItemId?: string,
        ) => ({
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId,
          }),
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId,
          }),
          providerThreadId: turn.turnInput.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: providerRef(nativeItemId),
          parentItemId:
            parentNativeItemId === undefined
              ? null
              : idAllocator.derive.turnItemFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: parentNativeItemId,
                }),
          ordinal: itemOrdinal(turn, nativeItemId),
          startedAt,
          updatedAt,
        });

        const emitItemNode = (
          turn: ActiveOmpTurn,
          nativeItemId: string,
          kind: OrchestrationV2ExecutionNode["kind"],
          status: OrchestrationV2ExecutionNode["status"],
          startedAt: DateTime.Utc,
          completedAt: DateTime.Utc | null,
          parentNativeItemId?: string,
        ) =>
          emit({
            type: "node.updated",
            driver: OMP_PROVIDER,
            node: {
              id: idAllocator.derive.nodeFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId,
              }),
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              parentNodeId:
                parentNativeItemId === undefined
                  ? turn.turnInput.rootNodeId
                  : idAllocator.derive.nodeFromProviderItem({
                      driver: OMP_PROVIDER,
                      nativeItemId: parentNativeItemId,
                    }),
              rootNodeId: turn.turnInput.rootNodeId,
              kind,
              status,
              countsForRun: false,
              providerThreadId: turn.turnInput.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });

        const emitProviderRetry = Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          providerRetry: OmpProviderRetryState,
          status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
          updatedAt: DateTime.Utc,
        ) {
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: makeProviderRetryTurnItem({
              driver: OMP_PROVIDER,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: turn.turnInput.rootNodeId,
              providerThreadId: turn.turnInput.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              itemOrdinal: providerRetry.itemOrdinal,
              failure: providerRetry.failure,
              retry: providerRetry.retry,
              status,
              startedAt: providerRetry.startedAt,
              updatedAt,
            }),
          });
        });

        const compactionNativeItemId = (turn: ActiveOmpTurn): string =>
          `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

        const emitCompaction = Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          compaction: OmpCompactionState,
          status: OmpCompactionStatus,
          details: {
            readonly summary?: string;
            readonly beforeTokenCount?: number;
            readonly afterTokenCount?: number;
          } = {},
        ) {
          const emittedAt = yield* DateTime.now;
          const completedAt = status === "running" ? null : emittedAt;
          yield* emitItemNode(
            turn,
            compaction.nativeItemId,
            "system",
            status,
            compaction.startedAt,
            completedAt,
          );
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
              status,
              title: compactionTitle(status),
              completedAt,
              type: "compaction",
              driver: OMP_PROVIDER,
              ...details,
            },
          });
        });

        const emitStreamItem =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (
            turn: ActiveOmpTurn,
            item: OmpStreamItemState,
            streaming: boolean,
          ) {
            const emittedAt = yield* DateTime.now;
            const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
            yield* emitItemNode(
              turn,
              item.nativeItemId,
              item.kind,
              streaming ? "running" : "completed",
              item.startedAt,
              streaming ? null : emittedAt,
            );
            if (item.kind === "assistant_message") {
              const messageId = idAllocator.derive.messageFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: item.nativeItemId,
              });
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_PROVIDER,
                turnItem: {
                  ...base,
                  status: streaming ? "running" : "completed",
                  title: null,
                  completedAt: streaming ? null : emittedAt,
                  type: "assistant_message",
                  messageId,
                  text: item.text,
                  streaming,
                },
              });
              yield* emit({
                type: "message.updated",
                driver: OMP_PROVIDER,
                message: {
                  id: messageId,
                  threadId: turn.turnInput.threadId,
                  runId: turn.turnInput.runId,
                  nodeId: idAllocator.derive.nodeFromProviderItem({
                    driver: OMP_PROVIDER,
                    nativeItemId: item.nativeItemId,
                  }),
                  role: "assistant",
                  text: item.text,
                  attachments: [],
                  streaming,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: item.startedAt,
                  updatedAt: emittedAt,
                },
              });
              return;
            }
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "reasoning",
                text: item.text,
                streaming,
              },
            });
          });

        const scheduleStreamFlush =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (turn: ActiveOmpTurn, item: OmpStreamItemState) {
            if (item.flushScheduled || item.completed) return;
            item.flushScheduled = true;
            yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  item.flushScheduled = false;
                  return item.completed ? Effect.void : emitStreamItem(turn, item, true);
                }),
              ),
              Effect.forkIn(scope),
            );
          });

        const streamItemFor = Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          kind: OmpStreamItemState["kind"],
          contentIndex: number,
        ) {
          const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
          const existing = turn.streamItems.get(nativeItemId);
          if (existing !== undefined) return existing;
          const startedAt = yield* DateTime.now;
          const item: OmpStreamItemState = {
            nativeItemId,
            kind,
            text: "",
            completed: false,
            flushScheduled: false,
            startedAt,
          };
          turn.streamItems.set(nativeItemId, item);
          itemOrdinal(turn, nativeItemId);
          return item;
        });

        const completeStreamItem = (turn: ActiveOmpTurn, item: OmpStreamItemState, text?: string) =>
          Effect.suspend(() => {
            if (item.completed) return Effect.void;
            item.completed = true;
            if (text !== undefined && text.length > 0) item.text = text;
            return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
          });

        const completeOpenStreamItems = (turn: ActiveOmpTurn) =>
          Effect.forEach(
            Array.from(turn.streamItems.values()).filter((item) => !item.completed),
            (item) => completeStreamItem(turn, item),
            { discard: true },
          );

        const emitToolItem = Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          event: OmpRpcRecord,
          phase: "start" | "update" | "end",
        ) {
          const toolCallId = recordString(event, "toolCallId");
          const toolName = recordString(event, "toolName") ?? "tool";
          const parentToolCallId = recordString(event, "parentToolCallId");
          if (toolCallId === undefined) return;
          if (phase === "start") {
            turn.toolArgs.set(toolCallId, event["args"]);
            turn.toolNames.set(toolCallId, toolName);
          }
          const args = event["args"] ?? turn.toolArgs.get(toolCallId);
          if (phase === "end") {
            turn.toolArgs.delete(toolCallId);
            turn.toolNames.delete(toolCallId);
          }
          const emittedAt = yield* DateTime.now;
          const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
          turn.toolStartedAt.set(toolCallId, startedAt);
          const completed = phase === "end";
          const isError = event["isError"] === true;
          const resultRecord = completed ? event["result"] : event["partialResult"];
          const outputText = contentText(recordField(resultRecord, "content"));
          const status = completed
            ? isError
              ? turn.interrupted
                ? "interrupted"
                : "failed"
              : "completed"
            : "running";
          const base = baseItemFields(turn, toolCallId, startedAt, emittedAt, parentToolCallId);
          yield* emitItemNode(
            turn,
            toolCallId,
            "tool_call",
            status,
            startedAt,
            completed ? emittedAt : null,
            parentToolCallId,
          );
          const shared = {
            ...base,
            status,
            completedAt: completed ? emittedAt : null,
          } as const;
          if (toolName === "bash" || toolName === "powershell") {
            const exitCode =
              recordNumber(recordField(resultRecord, "structuredContent"), "exit_code") ??
              recordNumber(recordField(resultRecord, "details"), "exitCode");
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "command_execution",
                input: recordString(args, "command") ?? "",
                ...(outputText.length > 0 ? { output: outputText } : {}),
                ...(exitCode === undefined ? {} : { exitCode }),
              },
            });
            return;
          }
          if (toolName === "edit" || toolName === "write") {
            const fileName = recordString(args, "path") ?? recordString(args, "file_path");
            if (fileName !== undefined) {
              const diffStr =
                recordString(recordField(resultRecord, "details"), "patch") ??
                (isError && outputText.trim().length > 0 ? outputText : undefined);
              const newStr = toolName === "write" ? recordString(args, "content") : undefined;
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_PROVIDER,
                turnItem: {
                  ...shared,
                  title: toolName,
                  type: "file_change",
                  fileName,
                  ...(diffStr === undefined ? {} : { diffStr }),
                  ...(newStr === undefined ? {} : { newStr }),
                },
              });
              return;
            }
          }
          const output = ompToolOutput(resultRecord, toolName);
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "dynamic_tool",
              ...mcpToolPresentation({ toolName }),
              toolName,
              input: args ?? {},
              ...(output === undefined ? {} : { output }),
            },
          });
        });

        const cancelPrompt = Effect.fn("OmpAdapter.cancelPrompt")(function* (
          pending: PendingOmpPrompt,
          resolvedAt: DateTime.Utc,
        ) {
          if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
          yield* connection
            .send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              cancelled: true,
            })
            .pipe(Effect.ignore);
          pending.runtimeRequest = {
            ...pending.runtimeRequest,
            status: "cancelled",
            resolvedAt,
          };
          yield* emit({
            type: "runtime_request.updated",
            driver: OMP_PROVIDER,
            threadId: pending.node.threadId,
            runtimeRequest: pending.runtimeRequest,
          });
          yield* emit({
            type: "node.updated",
            driver: OMP_PROVIDER,
            node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...pending.turnItem,
              status: "cancelled",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

        const cancelPendingPrompts = Effect.fn("OmpAdapter.cancelPendingPrompts")(function* (
          resolvedAt: DateTime.Utc,
        ) {
          const pending = Array.from(pendingPrompts.values());
          pendingPrompts.clear();
          yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
            discard: true,
          });
        });

        const emitSystemNotice = Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          nativeItemId: string,
          message: string,
        ) {
          const emittedAt = yield* DateTime.now;
          yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
              status: "completed",
              completedAt: emittedAt,
              title: message,
              type: "system_notice",
              message,
            },
          });
        });

        const handleExtensionUiRequest = Effect.fnUntraced(function* (event: OmpRpcRecord) {
          const method = recordString(event, "method");
          const nativeRequestId = recordString(event, "id");
          if (method === undefined) return;
          if (method === "cancel") {
            const target = recordString(event, "targetId");
            const pending = Array.from(pendingPrompts.values()).find(
              (entry) => entry.nativeRequestId === target,
            );
            if (pending) {
              pendingPrompts.delete(String(pending.runtimeRequest.id));
              yield* cancelPrompt(pending, yield* DateTime.now);
            }
            return;
          }
          if (recordField(event, "secret") === true && nativeRequestId !== undefined) {
            yield* connection.send({
              type: "extension_ui_response",
              id: nativeRequestId,
              cancelled: true,
            });
            return;
          }
          if (method === "notify") {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            const message = recordString(event, "message") ?? "";
            if (turn === null || message.length === 0) return;
            yield* emitSystemNotice(
              turn,
              `notify:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
              message,
            );
            return;
          }
          if (
            method !== "select" &&
            method !== "confirm" &&
            method !== "input" &&
            method !== "editor"
          ) {
            yield* Effect.logDebug("Ignoring oh-my-pi extension UI update.", { method });
            return;
          }
          if (nativeRequestId === undefined) return;
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const createdAt = yield* DateTime.now;
          const timeout = recordNumber(event, "timeout");
          const expiresAt =
            timeout === undefined || timeout === 0
              ? null
              : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: OMP_PROVIDER,
            ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
            nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const title = recordString(event, "title") ?? method;
          const threadId =
            turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
          const providerThreadId = state?.providerThread.id ?? null;
          const providerTurnId = turn?.providerTurn.id ?? null;
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId,
            nativeRequestRef: providerRef(nativeRequestId),
            kind: method === "confirm" ? "command" : "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: turn?.turnInput.runId ?? null,
            parentNodeId: turn?.turnInput.rootNodeId ?? null,
            rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
            kind: method === "confirm" ? "approval_request" : "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: providerRef(nativeRequestId),
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: createdAt,
            completedAt: null,
          };
          const itemBase = {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            threadId,
            runId: turn?.turnInput.runId ?? null,
            nodeId,
            providerThreadId,
            providerTurnId,
            nativeItemRef: providerRef(nativeRequestId),
            parentItemId: null,
            ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
            status: "waiting" as const,
            title,
            startedAt: createdAt,
            completedAt: null,
            updatedAt: createdAt,
          };
          const turnItem: OrchestrationV2TurnItem =
            method === "confirm"
              ? {
                  ...itemBase,
                  type: "approval_request",
                  requestId,
                  requestKind: ompApprovalRequestKind(title),
                  prompt: recordString(event, "message") ?? title,
                }
              : {
                  ...itemBase,
                  type: "user_input_request",
                  requestId,
                  questions: [ompQuestion(nativeRequestId, method, title, event)],
                };
          const pending: PendingOmpPrompt = {
            nativeRequestId,
            method,
            questionId: nativeRequestId,
            expiresAt,
            expirationFiber: null,
            runtimeRequest,
            node,
            turnItem,
          };
          pendingPrompts.set(String(requestId), pending);
          yield* emit({
            type: "runtime_request.updated",
            driver: OMP_PROVIDER,
            threadId,
            runtimeRequest,
          });
          yield* emit({ type: "node.updated", driver: OMP_PROVIDER, node });
          yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem });
          if (expiresAt !== null) {
            const now = yield* DateTime.now;
            pending.expirationFiber = yield* Effect.sleep(
              Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
            ).pipe(
              Effect.andThen(
                Queue.offer(connection.events, {
                  type: "u4.ui_request_expired",
                  requestId: String(requestId),
                  pending,
                }),
              ),
              Effect.asVoid,
              Effect.forkIn(scope),
            );
          }
        });

        const emitExtensionError = Effect.fnUntraced(function* (event: OmpRpcRecord) {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          if (turn === null) {
            outOfTurnExtensionErrors.push(event);
            return;
          }
          const emittedAt = yield* DateTime.now;
          const nativeItemId = `extension-error:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
          const extensionName = ompExtensionDisplayName(recordString(event, "extensionPath"));
          const extensionEvent = recordString(event, "event");
          const detail = recordString(event, "error")?.trim();
          const message = [
            `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
            detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
          ]
            .filter((part): part is string => part !== undefined)
            .join("\n\n");
          const failure = makeProviderFailure({
            message,
            class: "provider_error",
            retryable: false,
          });
          yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
              status: "failed",
              title: extensionName,
              completedAt: emittedAt,
              type: "error",
              failure,
            },
          });
        });

        const listSessionEntries = (since: string | null, timeoutMs: number) =>
          request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
            Effect.map(ompSessionListing),
            Effect.orElseSucceed(() => null),
          );

        const captureTurnTreeRefs = Effect.fnUntraced(function* (
          timeoutMs = OMP_REQUEST_TIMEOUT_MS,
        ): Effect.fn.Return<OmpTurnTreeRefs | null> {
          const cursorWasStale = leafCursorStale;
          const previousLeaf = lastKnownLeaf;
          const fullListing = cursorWasStale || previousLeaf === null;
          const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
          const turnWalk =
            listing === null ? null : walkOmpBranch(listing.entries, listing.leafId, previousLeaf);
          const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
          const tree =
            rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
          if (listing === null || turnWalk === null || tree === null) {
            leafCursorStale = true;
            return null;
          }
          lastKnownLeaf = listing.leafId;
          leafCursorStale = false;
          const turnStartEntryId = turnWalk.userEntryIds.at(-1);
          const branch =
            rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
              ? walkOmpBranch(tree.entries, listing.leafId, null)
              : undefined;
          return {
            nativeTurnRef: cursorWasStale
              ? undefined
              : turnStartEntryId !== undefined
                ? providerRef(turnStartEntryId)
                : turnWalk.entryCount === 0
                  ? null
                  : undefined,
            leafId: listing.leafId,
            retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
          };
        });

        const finalizeTurn = Effect.fnUntraced(function* (state: OmpThreadState, readUsage = true) {
          const turn = state.activeTurn;
          if (turn === null) return;
          state.activeTurn = null;
          const interrupted = turn.interrupted || turn.nativeAborted;
          const completedAt = yield* DateTime.now;
          yield* completeOpenStreamItems(turn);
          for (const [toolCallId, args] of turn.toolArgs) {
            const toolName = turn.toolNames.get(toolCallId) ?? "tool";
            yield* emitToolItem(
              turn,
              {
                toolCallId,
                toolName,
                args,
                isError: true,
                result: { content: [{ type: "text", text: "Tool ended with the provider turn" }] },
              },
              "end",
            );
          }
          if (turn.activeCompaction !== null) {
            const status = interrupted
              ? "cancelled"
              : turn.failure === null
                ? "completed"
                : "failed";
            yield* emitCompaction(turn, turn.activeCompaction, status);
            turn.activeCompaction = null;
          }
          if (turn.activeProviderRetry !== null) {
            if (interrupted) {
              yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
              turn.activeProviderRetry = null;
            } else if (turn.failure === null) {
              yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
              turn.activeProviderRetry = null;
            }
          }
          yield* cancelPendingPrompts(completedAt);
          for (const messageId of turn.unreadSteers.splice(0)) {
            yield* emitSteerStatus(turn, messageId, interrupted ? "cancelled" : "completed");
          }
          const treeRefs =
            turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
          const tokenUsage = readUsage
            ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
            : undefined;
          const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
          yield* emit({
            type: "provider_turn.updated",
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
                ? {}
                : { nativeTurnRef: treeRefs.nativeTurnRef }),
              status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
              completedAt,
              ...(tokenUsage === undefined ? {} : { tokenUsage }),
              ...(turn.reportedModel === undefined ? {} : { model: turn.reportedModel }),
            },
          });
          yield* updateProviderThread(
            state,
            {
              status: "idle",
              ...(treeRefs === null
                ? {}
                : {
                    nativeConversationHeadRef:
                      treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                  }),
            },
            treeRefs?.retainedNativeTurnIds,
          );
          yield* updateProviderSession(
            failure !== null ? "error" : "ready",
            failure?.message ?? null,
          );
          if (failure !== null) {
            const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
            if (turn.activeProviderRetry !== null) {
              yield* emitProviderRetry(
                turn,
                { ...turn.activeProviderRetry, failure },
                "failed",
                completedAt,
              );
            } else {
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_PROVIDER,
                turnItem: {
                  ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                  status: "failed",
                  title: null,
                  completedAt,
                  type: "error",
                  failure,
                },
              });
            }
            yield* emit({
              type: "turn.terminal",
              driver: OMP_PROVIDER,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              runOrdinal: turn.turnInput.runOrdinal,
              failureItemOrdinal: itemOrdinal(turn, failureItemId),
              status: "failed",
              failure,
              ...(turn.activeProviderRetry === null
                ? {}
                : {
                    retry: turn.activeProviderRetry.retry,
                    retryStartedAt: turn.activeProviderRetry.startedAt,
                  }),
              threadDisposition: "reusable",
            });
          } else {
            yield* emit({
              type: "turn.terminal",
              driver: OMP_PROVIDER,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              runOrdinal: turn.turnInput.runOrdinal,
              status: interrupted ? "interrupted" : "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }
        });

        const stopPendingWake = Effect.fnUntraced(function* (wake: OmpWake) {
          if (pendingWake !== wake || threadState !== wake.state || closed) return;
          pendingWake = null;
          stopRequested = true;
          yield* cancelPendingPrompts(yield* DateTime.now);
          yield* connection.terminate;
        });

        yield* request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
        yield* request({ type: "set_subagent_subscription", level: "progress" });
        const bridge = yield* makeOmpMcpBridge(connection, mcpSession).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        const handleNativeChild = Effect.fn("OmpAdapter.handleNativeChild")(function* (
          event: OmpRpcRecord,
        ) {
          if (event.type !== "subagent_lifecycle" && event.type !== "subagent_progress")
            return false;
          const payload = event.payload;
          const index = recordNumber(payload, "index");
          const id =
            recordString(payload, "id") ??
            Array.from(nativeChildren.entries()).find(([, child]) => child.index === index)?.[0];
          if (!id) return true;
          const previous = nativeChildren.get(id);
          const prior =
            event.type === "subagent_lifecycle" && recordString(payload, "status") === "started"
              ? undefined
              : previous;
          const turn = prior?.turn ?? threadState?.activeTurn;
          if (!turn) return true;
          const nativeItemId = `${turn.providerTurn.id}:subagent:${id}`;
          const at = yield* DateTime.now;
          const progress = recordField(payload, "progress");
          const nativeStatus = recordString(payload, "status") ?? recordString(progress, "status");
          const status =
            nativeStatus === "completed"
              ? "completed"
              : nativeStatus === "failed"
                ? "failed"
                : nativeStatus === "aborted"
                  ? "interrupted"
                  : "running";
          const completed = status !== "running";
          const entity: OrchestrationV2Subagent = {
            id: idAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: turn.providerTurn.providerThreadId,
            childThreadId: null,
            nativeTaskRef: providerRef(id),
            prompt:
              recordString(payload, "task") ??
              prior?.entity.prompt ??
              recordString(payload, "description") ??
              "",
            title: recordString(payload, "agent") ?? prior?.entity.title ?? "oh-my-pi agent",
            model:
              recordString(progress, "resolvedModelIdentity") ??
              recordString(progress, "model") ??
              prior?.entity.model ??
              null,
            status,
            result:
              (Array.isArray(recordField(progress, "recentOutput"))
                ? (recordField(progress, "recentOutput") as unknown[])
                    .filter((s): s is string => typeof s === "string")
                    .join("\n")
                    .slice(-10000)
                : undefined) ??
              prior?.entity.result ??
              null,
            ...(recordString(progress, "lastText")
              ? { progress: recordString(progress, "lastText")! }
              : {}),
            startedAt: prior?.entity.startedAt ?? at,
            completedAt: completed ? at : null,
            updatedAt: at,
          };
          nativeChildren.set(id, { turn, entity, index });
          yield* emit({ type: "subagent.updated", driver: OMP_PROVIDER, subagent: entity });
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            sessionScoped: threadState?.activeTurn !== turn,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, entity.startedAt ?? at, at),
              title: entity.title,
              status,
              completedAt: entity.completedAt,
              type: "subagent",
              subagentId: entity.id,
              origin: "provider_native",
              driver: OMP_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: entity.prompt,
              result: entity.result,
            },
          });
          if (threadState)
            yield* updateProviderThread(threadState, {
              pendingBackgroundTasks: Array.from(nativeChildren.entries())
                .filter(([, child]) => child.entity.status === "running")
                .map(([taskId]) => ({
                  taskId,
                  kind: "subagent" as const,
                  providerInstanceId: options.instanceId,
                })),
            });
          return true;
        });

        const handleSessionEvent = Effect.fnUntraced(function* (event: OmpRpcRecord) {
          if (yield* bridge.handle(event)) return;
          if (yield* handleNativeChild(event)) return;
          if (event["type"] === "u4.extension_status_reset") {
            const reset = extensionStatusReset;
            if (reset !== null && event["reset"] === reset) {
              reset.previous = sessionEntity.extensionStatuses ?? [];
              reset.touched.clear();
              yield* clearExtensionStatuses();
              yield* Deferred.succeed(reset.ready, undefined);
            }
            return;
          }
          if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {
            yield* updateExtensionStatus(event);
            return;
          }
          const interactiveUiRequest =
            event["type"] === "extension_ui_request" &&
            ["select", "confirm", "input", "editor"].includes(String(event["method"]));
          if (
            threadState?.activeTurn === null &&
            pendingWake !== null &&
            !interactiveUiRequest &&
            !String(event["type"]).startsWith("u4.") &&
            event["type"] !== "response"
          ) {
            pendingWake.events.push(event);
            if (event["type"] === "agent_start") yield* updateProviderSession("running", null);
            if (event["type"] === "session_settled") yield* updateProviderSession("ready", null);
            return;
          }
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          switch (event["type"]) {
            case "agent_start": {
              if (
                turn === null &&
                state?.providerThread.appThreadId != null &&
                continuationRequests !== undefined &&
                !closed &&
                !stopRequested
              ) {
                const wake: OmpWake = { state, events: [event] };
                pendingWake = wake;
                if (rollbackBarrier !== null) {
                  yield* stopPendingWake(wake);
                  return;
                }
                yield* updateProviderSession("running", null);
                yield* continuationRequests
                  .offer({
                    threadId: state.providerThread.appThreadId,
                    providerThreadId: state.providerThread.id,
                    driver: OMP_PROVIDER,
                    detail: null,
                    delivery: "adapter_buffered",
                    dispatchIfCurrent: (dispatch) =>
                      sessionEventPermit.withPermits(1)(
                        Effect.suspend(() =>
                          pendingWake === wake && threadState === state && !closed
                            ? dispatch.pipe(
                                Effect.asSome,
                                Effect.tapError(() => stopPendingWake(wake)),
                              )
                            : Effect.succeedNone,
                        ),
                      ),
                    clearIfCurrent: () => sessionEventPermit.withPermits(1)(stopPendingWake(wake)),
                  })
                  .pipe(Effect.tapError(() => stopPendingWake(wake)));
                return;
              }
              if (turn === null) {
                unsolicitedActivityDetected = true;
                yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
                yield* connection.terminate;
                return;
              }
              turn.sawAgentActivity = true;
              turn.nativeAborted = false;
              turn.settleProbeGeneration += 1;
              return;
            }
            case "command_output": {
              if (turn !== null)
                yield* emitSystemNotice(
                  turn,
                  `command:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
                  recordString(event, "text") ?? recordString(event, "output") ?? "",
                );
              return;
            }
            case "message_start": {
              const role = recordString(event["message"], "role");
              if (turn !== null && role === "assistant") {
                turn.sawAgentActivity = true;
                turn.messageOrdinal += 1;
              }
              const readSteer = role === "user" ? turn?.unreadSteers.shift() : undefined;
              if (turn !== null && readSteer !== undefined) {
                yield* emitSteerStatus(turn, readSteer, "completed");
              }
              return;
            }
            case "message_update": {
              if (turn === null) return;
              turn.sawAgentActivity = true;
              if (turn.activeProviderRetry !== null) {
                const recoveredAt = yield* DateTime.now;
                yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", recoveredAt);
                turn.activeProviderRetry = null;
              }
              yield* reportLiveUsage(turn, event["usage"]);
              const delta = event["assistantMessageEvent"];
              const deltaType = recordString(delta, "type");
              const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
              if (deltaType === "text_delta" || deltaType === "thinking_delta") {
                const item = yield* streamItemFor(
                  turn,
                  deltaType === "text_delta" ? "assistant_message" : "reasoning",
                  contentIndex,
                );
                item.text += recordString(delta, "delta") ?? "";
                yield* scheduleStreamFlush(turn, item);
                return;
              }
              if (deltaType === "text_end" || deltaType === "thinking_end") {
                const item = yield* streamItemFor(
                  turn,
                  deltaType === "text_end" ? "assistant_message" : "reasoning",
                  contentIndex,
                );
                yield* completeStreamItem(
                  turn,
                  item,
                  recordString(delta, "content") ?? recordString(delta, "thinking"),
                );
                return;
              }
              return;
            }
            case "message_end": {
              if (turn === null) return;
              const message = event["message"];
              if (recordString(message, "role") !== "assistant") return;
              yield* completeOpenStreamItems(turn);
              const reportedProvider = recordString(message, "provider");
              const reportedModelId = recordString(message, "model");
              if (reportedProvider && reportedModelId) {
                turn.reportedModel = `${reportedProvider}/${reportedModelId}`;
              }
              if (recordString(message, "stopReason") === "error" && turn.failure === null) {
                turn.failure = makeProviderFailure({
                  message: recordString(message, "errorMessage") ?? "Omp reported a model error.",
                  class: "provider_error",
                });
              }
              return;
            }
            case "tool_execution_start":
              if (turn !== null) {
                turn.sawAgentActivity = true;
                yield* emitToolItem(turn, event, "start");
              }
              return;
            case "tool_execution_update":
              if (turn !== null) yield* emitToolItem(turn, event, "update");
              return;
            case "tool_execution_end":
              if (turn !== null) yield* emitToolItem(turn, event, "end");
              return;
            case "auto_compaction_start":
            case "manual_compaction_start":
            case "compaction_start": {
              if (turn === null) return;
              turn.settleProbeGeneration += 1;
              turn.sawCompaction = true;
              if (turn.activeCompaction !== null) {
                yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
              }
              const startedAt = yield* DateTime.now;
              const compaction = {
                nativeItemId: compactionNativeItemId(turn),
                startedAt,
              } satisfies OmpCompactionState;
              turn.activeCompaction = compaction;
              yield* emitCompaction(turn, compaction, "running");
              return;
            }
            case "auto_compaction_end":
            case "manual_compaction_end":
            case "compaction_end": {
              if (turn === null) return;
              const observedAt = yield* DateTime.now;
              const compaction = turn.activeCompaction ?? {
                nativeItemId: compactionNativeItemId(turn),
                startedAt: observedAt,
              };
              turn.activeCompaction = null;
              const result = event["result"];
              if (result === null || result === undefined) {
                if (event["skipped"] === true) {
                  yield* emitCompaction(turn, compaction, "completed", {
                    summary: recordString(event, "errorMessage") ?? "No compaction needed",
                  });
                  return;
                }
                if (event["aborted"] === true) {
                  yield* emitCompaction(turn, compaction, "cancelled");
                  if (
                    (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                    releasedPromptTurnId !== turn.providerTurn.id
                  ) {
                    yield* Effect.void;
                  }
                  return;
                }
                const errorMessage =
                  recordString(event, "errorMessage") ?? "Omp context compaction failed.";
                yield* emitCompaction(turn, compaction, "failed", {
                  summary: errorMessage.slice(0, 1_000),
                });
                if (
                  (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                  releasedPromptTurnId !== turn.providerTurn.id
                ) {
                  yield* Effect.void;
                }
                return;
              }
              if (event["willRetry"] === true) turn.failure = null;
              turn.latestCompactionAfterTokens =
                nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
              const summary = recordString(result, "summary");
              const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
              const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
              yield* emitCompaction(turn, compaction, "completed", {
                ...(summary === undefined ? {} : { summary }),
                ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
                ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
              });
              if (
                (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                releasedPromptTurnId !== turn.providerTurn.id
              ) {
                yield* Effect.void;
              }
              return;
            }
            case "auto_retry_start": {
              if (turn === null) return;
              const emittedAt = yield* DateTime.now;
              const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
              const maxAttempts = Math.max(
                attempt,
                Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
              );
              const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
              const failure = makeProviderFailure({
                message: recordString(event, "errorMessage") ?? "Omp provider request failed.",
                class: "provider_error",
                retryable: true,
              });
              const current = turn.activeProviderRetry;
              const providerRetry = {
                retry: { attempt, maxAttempts, retryDelayMs },
                failure,
                startedAt: current?.startedAt ?? emittedAt,
                itemOrdinal:
                  current?.itemOrdinal ??
                  itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
              } satisfies OmpProviderRetryState;
              turn.activeProviderRetry = providerRetry;
              yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
              return;
            }
            case "auto_retry_end": {
              if (turn === null) return;
              const emittedAt = yield* DateTime.now;
              if (event["success"] === true) {
                if (turn.activeProviderRetry !== null) {
                  const attempt = Math.max(
                    1,
                    Math.trunc(
                      recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                    ),
                  );
                  const recoveredRetry = {
                    ...turn.activeProviderRetry,
                    retry: { ...turn.activeProviderRetry.retry, attempt },
                  };
                  yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                  turn.activeProviderRetry = null;
                }
                turn.failure = null;
                return;
              }
              const failure = makeProviderFailure({
                message: recordString(event, "finalError") ?? "Omp auto-retry failed.",
                class: "provider_error",
                retryable: false,
              });
              const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
              const current = turn.activeProviderRetry;
              const providerRetry = {
                retry: {
                  attempt,
                  maxAttempts: current?.retry.maxAttempts ?? attempt,
                  retryDelayMs: current?.retry.retryDelayMs ?? null,
                },
                failure,
                startedAt: current?.startedAt ?? emittedAt,
                itemOrdinal:
                  current?.itemOrdinal ??
                  itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
              } satisfies OmpProviderRetryState;
              turn.activeProviderRetry = providerRetry;
              turn.failure = failure;
              yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
              return;
            }
            case "extension_ui_request":
              yield* handleExtensionUiRequest(event);
              return;
            case "extension_error": {
              yield* emitExtensionError(event);
              return;
            }
            case "agent_end": {
              if (
                turn !== null &&
                state !== null &&
                turn.turnInput.message.creationSource === "provider" &&
                (event.yielded === true ||
                  (event.yielded === undefined && event.isTerminal !== false))
              ) {
                nativeBackgroundWork = event.isTerminal === false;
                yield* finalizeTurn(state);
              }
              return;
            }
            case "session_settled": {
              nativeBackgroundWork = false;
              if (state !== null) {
                if (turn !== null && turn.turnInput.message.creationSource === "provider")
                  yield* finalizeTurn(state);
                else if (turn === null) yield* updateProviderThread(state, {});
              }
              return;
            }
            case "prompt_result": {
              const id = recordString(event, "id");
              const owner = id === undefined ? undefined : promptOwners.get(id);
              if (id !== undefined) promptOwners.delete(id);
              if (turn === null || state === null || owner?.providerTurnId !== turn.providerTurn.id)
                return;
              if (event.status === "error")
                turn.failure = makeProviderFailure({
                  message: recordString(event.error, "message") ?? "oh-my-pi prompt failed",
                  class: "provider_error",
                });
              if (event.status === "aborted") turn.nativeAborted = true;
              nativeBackgroundWork = event.sessionSettled === false;
              if (!promptOwners.size) yield* finalizeTurn(state);
              return;
            }
            case "response": {
              const id = recordString(event, "id");
              const index = pendingPromptResponses.findIndex((p) => p.id === id);
              const owner = index < 0 ? undefined : pendingPromptResponses.splice(index, 1)[0];
              if (!pendingPromptResponses.length && pendingPromptResponsesDrained !== null) {
                yield* Deferred.succeed(pendingPromptResponsesDrained, undefined);
                pendingPromptResponsesDrained = null;
              }
              if (event.command === "compact") {
                pendingCompactResponses.shift();
                if (turn !== null) turn.manualCompactInFlight = false;
              }
              if (turn === null || state === null) return;
              if (event.success === false && owner?.kind === "steer") {
                if (id) promptOwners.delete(id);
                if (owner.messageId !== undefined) {
                  const unread = turn.unreadSteers.indexOf(owner.messageId);
                  if (unread >= 0) turn.unreadSteers.splice(unread, 1);
                  yield* emitSteerStatus(turn, owner.messageId, "cancelled");
                }
                return;
              }
              if (
                event.success === false &&
                (owner?.kind === "turn_start" || event.command === "compact")
              ) {
                if (id) promptOwners.delete(id);
                turn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "oh-my-pi rejected input",
                  class: "provider_error",
                });
                yield* finalizeTurn(state);
              } else if (
                (owner?.kind === "turn_start" &&
                  recordField(event.data, "agentInvoked") === false) ||
                event.command === "compact"
              ) {
                if (id) promptOwners.delete(id);
                yield* finalizeTurn(state);
              }
              return;
            }
            case "u4.ui_request_expired": {
              const requestId = recordString(event, "requestId");
              if (requestId === undefined) return;
              const pending = pendingPrompts.get(requestId);
              if (pending === undefined || pending !== event["pending"]) return;
              pendingPrompts.delete(requestId);
              yield* cancelPrompt(pending, yield* DateTime.now);
              return;
            }
            case "u4.flush_extension_errors": {
              for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
                yield* emitExtensionError(extensionError);
              }
              return;
            }
            case "u4.rollback_barrier": {
              if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
                yield* Deferred.succeed(rollbackBarrier, undefined);
              return;
            }
            default:
              return;
          }
        });

        yield* Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(connection.events);
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (
                  ["compaction_start", "auto_compaction_start", "manual_compaction_start"].includes(
                    String(event["type"]),
                  )
                )
                  nativeCompacting = true;
                if (
                  ["compaction_end", "auto_compaction_end", "manual_compaction_end"].includes(
                    String(event["type"]),
                  )
                ) {
                  nativeCompacting = false;
                  for (const held of heldPrompts.splice(0)) {
                    const turn = threadState?.activeTurn;
                    if (
                      turn?.providerTurn.id !== held.providerTurnId ||
                      turn.interrupted ||
                      stopRequested
                    )
                      continue;
                    yield* sendPrompt(held);
                    releasedPromptTurnId = held.providerTurnId;
                  }
                }
                yield* handleSessionEvent(event).pipe(
                  Effect.ensuring(Effect.sync(() => (releasedPromptTurnId = null))),
                );
              }),
            );
          }
        }).pipe(
          Effect.catchCause((cause) =>
            sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                runtimeRetired = true;
                const state = threadState;
                closed = true;
                if (pendingPromptResponsesDrained !== null)
                  yield* Deferred.fail(
                    pendingPromptResponsesDrained,
                    protocolError("Omp transport closed while awaiting prompt acknowledgment"),
                  );
                if (extensionStatusReset !== null)
                  yield* Deferred.fail(
                    extensionStatusReset.ready,
                    protocolError("Omp transport closed during status reset"),
                  );
                if (rollbackBarrier !== null)
                  yield* Deferred.fail(
                    rollbackBarrier,
                    protocolError("Omp transport closed during rollback"),
                  );
                pendingWake = null;
                const interrupted = state?.activeTurn?.interrupted === true;
                if (state?.activeTurn != null) {
                  state.activeTurn.failure = interrupted
                    ? null
                    : makeProviderFailure({
                        cause,
                        message: "Omp process exited unexpectedly.",
                        class: "transport_error",
                      });
                  yield* finalizeTurn(state, false);
                } else {
                  yield* cancelPendingPrompts(yield* DateTime.now);
                }
                if (unsolicitedActivityDetected) {
                  yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
                  yield* Queue.end(events);
                } else if (stopRequested) {
                  yield* updateProviderSession("stopped", null);
                  yield* Queue.end(events);
                } else {
                  yield* updateProviderSession(
                    "error",
                    interrupted ? "Omp process was stopped." : "Omp process exited unexpectedly.",
                  );
                  yield* Queue.fail(
                    events,
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver: OMP_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                  );
                }
              }),
            ),
          ),
          Effect.forkIn(scope),
        );

        const discoverModels = Effect.fnUntraced(function* () {
          const modelsData = yield* request({ type: "get_available_models" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const models = recordField(modelsData, "models");
          if (Array.isArray(models)) {
            for (const model of models) rememberModelContextWindow(model);
            discoveredModels = models;
          }
        });

        const startupState = yield* request({ type: "get_state" });
        const startupProvider = recordString(recordField(startupState, "model"), "provider");
        const startupModel = recordString(recordField(startupState, "model"), "id");
        baselineModel =
          startupProvider && startupModel
            ? { provider: startupProvider, modelId: startupModel }
            : null;
        baselineThinking = recordString(startupState, "thinkingLevel") ?? null;
        const registerThread = Effect.fnUntraced(function* (
          threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
          publish = true,
        ) {
          if (rollbackBarrier !== null)
            return yield* protocolError("Cannot register a Omp thread during rollback");
          if (threadState !== null && threadState.activeTurn !== null) {
            return yield* protocolError("Cannot register a Omp thread while a turn is active");
          }
          if (pendingWake !== null) {
            const state = threadState;
            if (
              state !== null &&
              state === pendingWake.state &&
              state.providerThread.appThreadId === threadInput.threadId &&
              (threadInput.existingProviderThread === undefined ||
                threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                  state.providerThread.nativeThreadRef?.nativeId)
            )
              return state.providerThread;
            return yield* protocolError(
              "Cannot switch Omp threads while native work is awaiting a turn",
            );
          }
          if (failedNativeResume && threadInput.existingProviderThread?.nativeThreadRef == null)
            return yield* protocolError(
              "The saved oh-my-pi session could not be resumed; refusing to replace it",
            );
          const existing = threadInput.existingProviderThread;
          const resumeId = existing?.nativeThreadRef?.nativeId;
          const needsNewSession = resumeId == null && registrationAttempted;
          registrationAttempted = true;
          if (
            resumeId != null &&
            !path.resolve(resumeId).startsWith(path.resolve(sessionDir) + path.sep)
          )
            return yield* protocolError("Refusing a session outside this oh-my-pi instance");
          if (
            resumeId != null &&
            !(yield* fileSystem.exists(resumeId).pipe(Effect.orElseSucceed(() => false)))
          )
            return yield* protocolError("The saved oh-my-pi session file is missing");
          if (resumeId != null || needsNewSession) {
            lastNativeThreadId = resumeId ?? lastNativeThreadId;
            threadState = null;
            appliedModel = null;
            selectionInitialized = false;
            appliedThinking = null;
            appliedSessionName = null;

            contextWindow = null;
            const result = yield* lifecycleRequest(
              resumeId != null
                ? { type: "switch_session", sessionPath: resumeId }
                : { type: "new_session" },
            );
            if (recordField(result, "cancelled") === true) {
              return yield* protocolError("A Omp extension cancelled the session switch");
            }
          }
          const stateData = yield* request({ type: "get_state" });
          if (discoveredModels === null) yield* discoverModels();
          contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
          if (baselineModel === null && appliedModel === null) {
            const stateModel = recordField(stateData, "model");
            const provider = recordString(stateModel, "provider");
            const modelId = recordString(stateModel, "id");
            if (provider !== undefined && modelId !== undefined) {
              baselineModel = { provider, modelId };
            }
          }
          if (baselineThinking === null && appliedThinking === null) {
            baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
            appliedThinking = baselineThinking;
          }
          const nativeId = recordString(stateData, "sessionFile");
          if (nativeId === undefined) {
            return yield* protocolError("get_state returned no persisted sessionFile", stateData);
          }
          if (resumeId != null && nativeId !== resumeId)
            return yield* protocolError("oh-my-pi resumed a different session");
          if (needsNewSession && nativeId === lastNativeThreadId) {
            return yield* protocolError("Omp did not create a distinct session file");
          }
          lastNativeThreadId = nativeId;
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread =
            existing !== undefined
              ? {
                  ...existing,
                  providerSessionId: input.providerSessionId,
                  nativeThreadRef: providerRef(nativeId),
                  ...(needsNewSession
                    ? { nativeConversationHeadRef: null, contextUsage: null }
                    : {}),
                  status: "idle",
                  updatedAt: createdAt,
                }
              : {
                  id: idAllocator.derive.providerThread({
                    driver: OMP_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  driver: OMP_PROVIDER,
                  providerInstanceId: options.instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadInput.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  pendingBackgroundTasks: [],
                  createdAt,
                  updatedAt: createdAt,
                };
          threadState = { providerThread, activeTurn: null };
          const baselineEntries = yield* request({ type: "get_entries" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
          leafCursorStale = baselineEntries === undefined;
          if (publish)
            yield* emit({
              type: "provider_thread.updated",
              driver: OMP_PROVIDER,
              providerThread,
            });
          return providerThread;
        });

        const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
          const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
          const firstSelection = !selectionInitialized;
          selectionInitialized = true;
          if (modelSelection.model === OMP_INHERIT_MODEL_SLUG) {
            if ((appliedModel !== null || firstSelection) && baselineModel !== null) {
              const restoredModel = yield* request({ type: "set_model", ...baselineModel });
              appliedThinking = null;
              contextWindow = rememberModelContextWindow(restoredModel);
              appliedModel = null;
              const updatedAt = yield* DateTime.now;
              sessionEntity = { ...sessionEntity, model: OMP_INHERIT_MODEL_SLUG, updatedAt };
              yield* emit({
                type: "provider_session.updated",
                driver: OMP_PROVIDER,
                providerSession: sessionEntity,
              });
            }
            if (
              thinking === undefined &&
              baselineThinking !== null &&
              appliedThinking !== baselineThinking
            ) {
              yield* request({ type: "set_thinking_level", level: baselineThinking });
              appliedThinking = baselineThinking;
            }
          } else if (modelSelection.model !== appliedModel) {
            if (findReportedOmpModel(modelSelection.model, discoveredModels) === undefined) {
              yield* discoverModels();
            }
            const parsed = resolveOmpModelSlug(modelSelection.model, discoveredModels);
            if (parsed === null) {
              return yield* protocolError(
                `Omp model '${modelSelection.model}' must use provider/model format`,
              );
            }
            const selectedModel = yield* request({
              type: "set_model",
              provider: parsed.provider,
              modelId: parsed.modelId,
            });
            appliedThinking = null;
            contextWindow = rememberModelContextWindow(selectedModel);
            appliedModel = modelSelection.model;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: OMP_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          if (
            thinking !== undefined &&
            thinking !== appliedThinking &&
            (yield* request({ type: "get_available_thinking_levels" }).pipe(
              Effect.map((data) => {
                const levels = recordField(data, "levels");
                return Array.isArray(levels) && levels.includes(thinking);
              }),
            ))
          ) {
            yield* request({ type: "set_thinking_level", level: thinking });
            appliedThinking = thinking;
          }
        });

        const resolvePromptPayload = Effect.fnUntraced(function* (
          text: string,
          attachments: ReadonlyArray<ChatAttachment>,
        ) {
          const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
          const message = yield* providerMessageTextWithAttachmentPaths({
            text,
            attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          });
          for (const attachment of attachments) {
            const path = host.resolveAttachmentPath(attachment);
            if (path === null) continue;
            if (attachment.mimeType.startsWith("image/")) {
              const bytes = yield* fileSystem.readFile(path);
              images.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }
          return { message, images };
        });

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: OMP_PROVIDER,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return sessionEntity;
          },
          events: Stream.fromQueue(events),
          backgroundTasksEndWithProcess: true,
          stopSubagent: Effect.fn("OmpAdapter.stopSubagent")(function* ({
            nativeTaskId,
            requestedAt,
            providerThread,
          }) {
            const child = nativeChildren.get(nativeTaskId);
            if (
              !child ||
              child.entity.providerThreadId !== providerThread.id ||
              child.entity.status !== "running"
            )
              return;
            if (
              requestedAt !== undefined &&
              child.entity.startedAt !== null &&
              DateTime.toEpochMillis(child.entity.startedAt) > DateTime.toEpochMillis(requestedAt)
            )
              return;
            yield* request({ type: "cancel_subagent", subagentId: nativeTaskId }).pipe(
              Effect.mapError((cause) => protocolError("Could not cancel native subagent", cause)),
            );
          }),
          hasPendingBackgroundWork: Effect.sync(() => nativeBackgroundWork || pendingWake !== null),
          hasPendingBackgroundWorkForThread: (providerThread) =>
            Effect.sync(
              () =>
                (nativeBackgroundWork || pendingWake !== null) &&
                threadState?.providerThread.id === providerThread.id,
            ),
          getModelContextWindow: (selection) => {
            if (selection.instanceId !== options.instanceId) return undefined;
            const slug =
              selection.model === OMP_INHERIT_MODEL_SLUG
                ? baselineModel === null
                  ? undefined
                  : `${baselineModel.provider}/${baselineModel.modelId}`
                : selection.model;
            return slug === undefined ? undefined : modelContextWindows.get(slug);
          },
          ensureThread: (threadInput) =>
            registerThread(threadInput).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: OMP_PROVIDER,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            registerThread({
              threadId:
                threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
              modelSelection: threadInput.modelSelection ?? input.modelSelection,
              runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: threadInput.providerThread,
            }).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  failedNativeResume = true;
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  failedNativeResume = false;
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver: OMP_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          compactThread: (turnInput) =>
            runtime.startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compact" },
            }),
          startTurn: Effect.fn("OmpAdapter.startTurn")(
            function* (turnInput) {
              if (rollbackBarrier !== null)
                return yield* protocolError("Cannot start a Omp turn during rollback");
              if (isOmpHostOwnedCommand(turnInput.message.text))
                return yield* protocolError(
                  "Use U4 controls to change sessions, models or permissions; this native command is not exposed",
                );
              const state = threadState;
              if (state === null) {
                return yield* protocolError("Omp session has no registered thread");
              }
              while (true) {
                if (state.activeTurn !== null) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: OMP_PROVIDER,
                    detail: `Omp provider thread ${turnInput.providerThread.id} already has an active turn`,
                    reason: "previous_turn_active",
                  });
                }
                if (closed || stopRequested)
                  return yield* protocolError("Cannot start a Omp turn after session closure");
                if (pendingPromptResponsesDrained === null) break;
                yield* Deferred.await(pendingPromptResponsesDrained);
              }
              if (
                state.providerThread.nativeThreadRef?.nativeId !==
                turnInput.providerThread.nativeThreadRef?.nativeId
              ) {
                return yield* protocolError("Omp turn requested for a different native session");
              }
              const continuation =
                turnInput.message.createdBy === "agent" &&
                turnInput.message.creationSource === "provider";
              if (!continuation) yield* applySelection(turnInput.modelSelection);
              if (turnInput.appThread.title !== appliedSessionName) {
                yield* request({
                  type: "set_session_name",
                  name: turnInput.appThread.title,
                }).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                  ),
                  Effect.ignore,
                );
              }
              const compactCommand = continuation
                ? null
                : parseOmpCompactCommand(turnInput.message.text);
              const payload =
                !continuation && compactCommand === null
                  ? yield* resolvePromptPayload(
                      turnInput.message.text,
                      turnInput.message.attachments,
                    )
                  : null;
              const startedAt = yield* DateTime.now;
              const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: idAllocator.derive.providerTurn({
                  driver: OMP_PROVIDER,
                  nativeTurnId: syntheticNativeTurnId,
                }),
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              };
              const activeTurn: ActiveOmpTurn = {
                turnInput,
                providerTurn,
                startedAt,
                itemOrdinals: new Map(),
                nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                messageOrdinal: 0,
                streamItems: new Map(),
                toolArgs: new Map(),
                toolNames: new Map(),
                toolStartedAt: new Map(),
                interrupted: false,
                nativeAborted: false,
                sawAgentActivity: false,
                adoptedWake: false,
                promptMayBeCommandOnly:
                  compactCommand !== null ||
                  (payload?.message.trimStart().startsWith("/") ?? false),
                latestCompactionAfterTokens: null,
                lastLiveUsedTokens: null,
                settleProbeGeneration: 0,
                settleWhenIdle: false,
                sawCompaction: false,
                manualCompactInFlight: compactCommand !== null,
                activeCompaction: null,
                activeProviderRetry: null,
                failure: null,
                rejectedPromptFailure: null,
                unreadSteers: [],
              };
              while (true) {
                const pendingAck = yield* Effect.gen(function* () {
                  if (
                    threadState !== state ||
                    state.activeTurn !== null ||
                    closed ||
                    stopRequested ||
                    rollbackBarrier !== null ||
                    state.providerThread.nativeThreadRef?.nativeId !==
                      turnInput.providerThread.nativeThreadRef?.nativeId
                  ) {
                    return yield* protocolError("Omp turn ownership changed before it could start");
                  }
                  if (pendingPromptResponsesDrained !== null) return pendingPromptResponsesDrained;
                  const wake = pendingWake?.state === state ? pendingWake : null;
                  if (
                    wake !== null &&
                    wake.state.providerThread.appThreadId !== turnInput.threadId
                  ) {
                    return yield* protocolError(
                      "Omp native wake belongs to a different app thread",
                    );
                  }
                  pendingWake = null;
                  state.providerThread = turnInput.providerThread;
                  state.activeTurn = activeTurn;
                  activeTurn.adoptedWake = wake !== null && !continuation;
                  if (compactCommand !== null) {
                    yield* connection.send(compactRpcRecord(compactCommand));
                    pendingCompactResponses.push({
                      providerTurnId: providerTurn.id,
                      kind: "turn_start",
                    });
                  } else if (payload !== null) {
                    yield* sendPrompt({
                      providerTurnId: providerTurn.id,
                      kind: "turn_start",
                      record: {
                        type: "prompt",
                        message: payload.message,
                        streamingBehavior: "steer",
                        ...(payload.images.length === 0 ? {} : { images: payload.images }),
                      },
                    });
                  }
                  yield* emit({
                    type: "provider_turn.updated",
                    driver: OMP_PROVIDER,
                    threadId: turnInput.threadId,
                    providerTurn,
                  });
                  yield* updateProviderThread(state, {
                    status: "active",
                    firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                    lastRunOrdinal: turnInput.runOrdinal,
                  });
                  yield* updateProviderSession("running", null);
                  if (wake !== null) {
                    for (const event of wake.events) {
                      if (!continuation && event["type"] === "session_settled") {
                        activeTurn.nativeAborted = event["aborted"] === true;
                        activeTurn.settleWhenIdle = true;
                        continue;
                      }
                      yield* handleSessionEvent(event);
                    }
                  } else if (continuation) {
                    yield* finalizeTurn(state);
                  }
                  if (outOfTurnExtensionErrors.length > 0) {
                    yield* Queue.offer(connection.events, { type: "u4.flush_extension_errors" });
                  }
                  return null;
                }).pipe(
                  sessionEventPermit.withPermits(1),
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      if (state.activeTurn === activeTurn) state.activeTurn = null;
                    }),
                  ),
                );
                if (pendingAck === null) break;
                yield* Deferred.await(pendingAck);
              }
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver: OMP_PROVIDER,
                      threadId: turnInput.threadId,
                      providerThreadId: turnInput.providerThread.id,
                      runId: turnInput.runId,
                      cause,
                    }),
                ),
              ),
          ),
          steerTurn: Effect.fn("OmpAdapter.steerTurn")(
            function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
              if (isOmpHostOwnedCommand(steerInput.message.text))
                return yield* protocolError("This native command is not exposed by U4");
              const turn = threadState?.activeTurn ?? null;
              if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
                return yield* protocolError(`Omp turn ${steerInput.providerTurnId} is not active`);
              }
              const compactCommand = parseOmpCompactCommand(steerInput.message.text);
              const payload =
                compactCommand === null
                  ? yield* resolvePromptPayload(
                      steerInput.message.text,
                      steerInput.message.attachments,
                    )
                  : null;
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (threadState?.activeTurn !== turn) {
                    return yield* protocolError(
                      `Omp turn ${steerInput.providerTurnId} is not active`,
                    );
                  }
                  if (compactCommand !== null) {
                    turn.manualCompactInFlight = true;
                    yield* connection.send(compactRpcRecord(compactCommand));
                    pendingCompactResponses.push({
                      providerTurnId: turn.providerTurn.id,
                      kind: "steer",
                    });
                  } else if (payload !== null) {
                    yield* sendPrompt({
                      providerTurnId: turn.providerTurn.id,
                      kind: "steer",
                      messageId: steerInput.message.messageId,
                      record: {
                        type: "prompt",
                        message: payload.message,
                        streamingBehavior: "steer",
                        ...(payload.images.length === 0 ? {} : { images: payload.images }),
                      },
                    });
                  }
                  turn.settleProbeGeneration += 1;
                }),
              );
            },
            (effect, steerInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver: OMP_PROVIDER,
                      providerThreadId: steerInput.providerThread.id,
                      providerTurnId: steerInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(
            function* (interruptInput) {
              const turn = threadState?.activeTurn ?? null;
              if (turn === null && interruptInput.requestRuntimeRestart === true) {
                if (pendingWake !== null)
                  yield* sessionEventPermit.withPermits(1)(stopPendingWake(pendingWake));
                return;
              }
              if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
                return yield* protocolError(
                  `Omp turn ${interruptInput.providerTurnId} is not active`,
                );
              }
              turn.interrupted = true;
              if (
                interruptInput.requestRuntimeRestart === true ||
                turn.settleWhenIdle ||
                turn.activeCompaction !== null ||
                turn.manualCompactInFlight ||
                nativeCompacting
              ) {
                stopRequested = true;
                if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                  yield* Effect.void;
                  yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
                }
                yield* sessionEventPermit.withPermits(1)(
                  Effect.gen(function* () {
                    if (threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                      turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                    }
                    yield* connection.terminate;
                  }),
                );
                return;
              }
              yield* Effect.void;
              yield* request({ type: "abort_and_restore_queue" }).pipe(
                Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
              );
            },
            (effect, interruptInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver: OMP_PROVIDER,
                      providerThreadId: interruptInput.providerThread.id,
                      providerTurnId: interruptInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(
            function* (requestInput) {
              const pending = pendingPrompts.get(String(requestInput.requestId));
              if (pending === undefined) {
                return yield* protocolError(
                  `No pending Omp extension request ${requestInput.requestId}`,
                );
              }
              const answeredAt = yield* DateTime.now;
              if (
                pending.expiresAt !== null &&
                DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
              ) {
                pendingPrompts.delete(String(requestInput.requestId));
                yield* cancelPrompt(pending, answeredAt);
                return yield* protocolError(
                  `Omp extension request ${requestInput.requestId} has expired`,
                );
              }
              const response = ompUiResponse(pending, requestInput.decision, requestInput.answers);
              yield* connection.send({
                type: "extension_ui_response",
                id: pending.nativeRequestId,
                ...response,
              });
              pendingPrompts.delete(String(requestInput.requestId));
              if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
              const resolvedAt = yield* DateTime.now;
              pending.runtimeRequest = {
                ...pending.runtimeRequest,
                status: "resolved",
                resolvedAt,
              };
              yield* emit({
                type: "runtime_request.updated",
                driver: OMP_PROVIDER,
                threadId: pending.node.threadId,
                runtimeRequest: pending.runtimeRequest,
              });
              yield* emit({
                type: "node.updated",
                driver: OMP_PROVIDER,
                node: { ...pending.node, status: "completed", completedAt: resolvedAt },
              });
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_PROVIDER,
                turnItem: {
                  ...pending.turnItem,
                  status: "completed",
                  completedAt: resolvedAt,
                  updatedAt: resolvedAt,
                },
              });
            },
            (effect, requestInput) =>
              effect.pipe(
                sessionEventPermit.withPermits(1),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver: OMP_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
                ),
              ),
          ),
          readThreadSnapshot: Effect.fn("OmpAdapter.readThreadSnapshot")(
            function* (snapshotInput) {
              const state = threadState;
              const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
              const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
              if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
                return yield* protocolError(
                  "Omp snapshot requested for a thread this session does not host",
                );
              }
              const messagesData = yield* request({ type: "get_messages" });
              const activeMessages = recordField(messagesData, "messages");
              const threadId = state.providerThread.appThreadId ?? input.threadId;
              const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
                (message, index) => {
                  const role = recordString(message, "role");
                  if (role !== "user" && role !== "assistant") return [];
                  const text = contentText(recordField(message, "content"));
                  if (text.length === 0) return [];
                  const timestamp = recordNumber(message, "timestamp");
                  const at = Option.getOrElse(
                    DateTime.make(timestamp ?? Number.NaN),
                    () => state.providerThread.createdAt,
                  );
                  return [
                    {
                      id: idAllocator.derive.messageFromProviderItem({
                        driver: OMP_PROVIDER,
                        nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                      }),
                      threadId,
                      runId: null,
                      nodeId: null,
                      role: role as "user" | "assistant",
                      text,
                      attachments: [],
                      streaming: false,
                      createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                      creationSource: "provider" as const,
                      createdAt: at,
                      updatedAt: at,
                    },
                  ];
                },
              );
              return {
                providerThread: state.providerThread,
                providerTurns: [],
                messages,
                runtimeRequests: [],
              };
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver: OMP_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(
            function* (rollbackInput) {
              if (
                threadState === null &&
                rollbackInput.providerThread.nativeThreadRef?.nativeId != null
              ) {
                yield* registerThread(
                  {
                    threadId: rollbackInput.providerThread.appThreadId ?? input.threadId,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                    existingProviderThread: rollbackInput.providerThread,
                  },
                  false,
                );
              }
              const state = threadState;
              if (state === null) {
                return yield* protocolError("Omp session has no registered thread");
              }
              if (state.providerThread.id !== rollbackInput.providerThread.id) {
                return yield* protocolError(
                  "Omp rollback requested for a thread this session does not host",
                );
              }
              if (state.activeTurn !== null) {
                return yield* protocolError("Cannot roll back while a Omp turn is active");
              }
              if (pendingWake !== null) {
                return yield* protocolError("Cannot roll back while native Omp work awaits a turn");
              }
              const boundary = ompForkBoundary(rollbackInput);
              if (boundary.type === "nothing") {
                return ompThreadSnapshot(state.providerThread);
              }
              const forkEntryId = yield* ompForkEntry(
                boundary,
                rollbackInput.providerThread.createdAt,
                request({ type: "get_entries" }),
              );
              return yield* Effect.acquireUseRelease(
                sessionEventPermit.withPermits(1)(
                  Effect.gen(function* () {
                    if (
                      rollbackBarrier !== null ||
                      threadState !== state ||
                      state.activeTurn !== null ||
                      pendingWake !== null ||
                      closed ||
                      stopRequested
                    )
                      return yield* protocolError(
                        "Omp rollback ownership changed before its fork could start",
                      );
                    const barrier = yield* Deferred.make<
                      void,
                      ProviderAdapter.ProviderAdapterProtocolError
                    >();
                    rollbackBarrier = barrier;
                    return barrier;
                  }),
                ),
                (barrier) =>
                  Effect.gen(function* () {
                    const forkData = yield* lifecycleRequest(forkEntryId);
                    if (recordField(forkData, "cancelled") === true)
                      return yield* protocolError("A Omp extension cancelled the session fork");
                    const forkState = yield* request({ type: "get_state" }).pipe(
                      Effect.onError(() =>
                        Effect.sync(() => {
                          threadState = null;
                        }),
                      ),
                    );
                    const forkSessionFile = recordString(forkState, "sessionFile");
                    if (forkSessionFile === undefined) {
                      threadState = null;
                      return yield* protocolError(
                        "Omp fork did not return a persisted session file",
                      );
                    }
                    const entriesData = yield* request({ type: "get_entries" }).pipe(
                      Effect.orElseSucceed(() => undefined),
                    );
                    const leafId = recordString(entriesData, "leafId") ?? null;
                    const queued = yield* Queue.offer(connection.events, {
                      type: "u4.rollback_barrier",
                      barrier,
                    });
                    if (!queued)
                      return yield* protocolError("Omp transport closed during rollback");
                    yield* Deferred.await(barrier);
                    return yield* sessionEventPermit.withPermits(1)(
                      Effect.gen(function* () {
                        if (pendingWake !== null) {
                          yield* stopPendingWake(pendingWake);
                          return yield* protocolError(
                            "Native Omp work started while rollback was changing the session",
                          );
                        }
                        if (
                          threadState !== state ||
                          state.activeTurn !== null ||
                          closed ||
                          stopRequested
                        )
                          return yield* protocolError(
                            "Omp rollback ownership changed during its fork",
                          );
                        lastNativeThreadId = forkSessionFile;
                        appliedModel = null;
                        selectionInitialized = false;
                        appliedThinking = null;
                        appliedSessionName = null;
                        lastKnownLeaf = leafId;
                        leafCursorStale = entriesData === undefined;
                        yield* updateProviderThread(state, {
                          nativeThreadRef: providerRef(forkSessionFile),
                          nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                        });
                        rollbackBarrier = null;
                        return ompThreadSnapshot(state.providerThread);
                      }),
                    );
                  }).pipe(Effect.onInterrupt(() => connection.terminate)),
                (barrier) =>
                  Effect.sync(() => {
                    if (rollbackBarrier === barrier) rollbackBarrier = null;
                  }),
              );
            },
            (effect, rollbackInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRollbackThreadError({
                      driver: OMP_PROVIDER,
                      providerThreadId: rollbackInput.providerThread.id,
                      checkpointId: rollbackInput.target.checkpointId,
                      cause,
                    }),
                ),
              ),
          ),
          forkThread: Effect.fn("OmpAdapter.forkThread")(
            function* (forkInput) {
              if (threadState?.activeTurn != null) {
                return yield* protocolError("Cannot fork while a Omp turn is active");
              }
              const source = forkInput.sourceProviderThread;
              const sourceFile = source.nativeThreadRef?.nativeId;
              if (sourceFile == null)
                return yield* protocolError("Omp fork source has no session file");
              const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
                (turn) => turn.providerThreadId === source.id,
              );
              const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
              if (forkInput.providerTurnId !== undefined && target === undefined) {
                return yield* protocolError("Omp fork target turn is missing");
              }
              const boundary: OmpForkBoundary =
                target === undefined
                  ? { type: "nothing" }
                  : ompForkBoundary({
                      target: { type: "provider_turn", providerTurn: target },
                      providerThreadTurns: sourceTurns,
                    });
              const forkLaunch = buildOmpRpcLaunch({
                launchArgs: resolvedLaunchArgs.args,
                environment: options.environment,
                sessionDir,
                shortLived: true,
                disableExtensions: true,
                disableTools: true,
              });
              const nativeId = yield* Effect.scoped(
                Effect.gen(function* () {
                  const forkConnection = yield* makeOmpRpcConnection({
                    command: options.settings.binaryPath || "omp",
                    args: [...forkLaunch.args, "--fork", sourceFile],
                    cwd: forkInput.runtimePolicy?.cwd ?? cwd,
                    env: forkLaunch.env,
                  });
                  yield* Stream.fromQueue(forkConnection.events).pipe(
                    Stream.runDrain,
                    Effect.ignore,
                    Effect.forkScoped,
                  );
                  const beforeEntry =
                    boundary.type === "nothing"
                      ? null
                      : yield* ompForkEntry(
                          boundary,
                          source.createdAt,
                          forkConnection.request({ type: "get_entries" }),
                        );
                  if (beforeEntry !== null) {
                    const result = yield* forkConnection.request(beforeEntry);
                    if (recordField(result, "cancelled") === true) {
                      return yield* protocolError("A Omp extension cancelled the session fork");
                    }
                  }
                  const state = yield* forkConnection.request({ type: "get_state" });
                  const file = recordString(state, "sessionFile");
                  if (file === undefined || file === sourceFile) {
                    return yield* protocolError("Omp fork did not create a distinct session file");
                  }
                  const lines = yield* fileSystem
                    .stream(file)
                    .pipe(
                      Stream.decodeText(),
                      Stream.splitLines,
                      Stream.take(2),
                      Stream.runCollect,
                    );
                  const header = lines
                    .map((line) => {
                      try {
                        const value: unknown = JSON.parse(line);
                        return value;
                      } catch {
                        return undefined;
                      }
                    })
                    .find((value) => recordField(value, "type") === "session");
                  if (
                    recordString(header, "cwd") !==
                    path.resolve(forkInput.runtimePolicy?.cwd ?? cwd)
                  )
                    return yield* protocolError("oh-my-pi fork retained the source cwd");
                  return file;
                }),
              ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
              const now = yield* DateTime.now;
              return yield* registerThread(
                {
                  threadId: forkInput.targetThreadId,
                  modelSelection: forkInput.modelSelection ?? input.modelSelection,
                  runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                  existingProviderThread: {
                    ...source,
                    id: idAllocator.derive.providerThread({
                      driver: OMP_PROVIDER,
                      nativeThreadId: nativeId,
                    }),
                    appThreadId: forkInput.targetThreadId,
                    providerSessionId: input.providerSessionId,
                    providerInstanceId: options.instanceId,
                    ownerNodeId: forkInput.ownerNodeId ?? null,
                    nativeThreadRef: providerRef(nativeId),
                    nativeConversationHeadRef: null,
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    pendingBackgroundTasks: [],
                    forkedFrom: {
                      providerThreadId: source.id,
                      ...(forkInput.providerTurnId === undefined
                        ? {}
                        : { providerTurnId: forkInput.providerTurnId }),
                    },
                    createdAt: now,
                    updatedAt: now,
                  },
                },
                false,
              );
            },
            (effect, forkInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: OMP_PROVIDER,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              ),
          ),
        };
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

interface OmpSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  readonly isMessage: boolean;
  /** Omp's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

interface OmpSessionListing {
  readonly entries: ReadonlyMap<string, OmpSessionEntry>;
  readonly leafId: string | null;
}

function ompSessionListing(data: unknown): OmpSessionListing | null {
  const leafId = recordField(data, "leafId");
  const entries = ompSessionEntries(recordField(data, "entries"));
  return entries !== null && (typeof leafId === "string" || leafId === null)
    ? { entries, leafId }
    : null;
}

function ompSessionEntries(entries: unknown): ReadonlyMap<string, OmpSessionEntry> | null {
  const byId = new Map<string, OmpSessionEntry>();
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const id = recordString(entry, "id");
    const parentId = recordField(entry, "parentId");
    if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
      return null;
    const timestamp = recordString(entry, "timestamp");
    byId.set(id, {
      parentId,
      isMessage: recordField(entry, "type") === "message",
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    });
  }
  return byId;
}

function walkOmpBranch(
  entries: ReadonlyMap<string, OmpSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

type OmpForkBoundary =
  | { readonly type: "entry"; readonly entryId: string }
  | { readonly type: "nothing" }
  | {
      readonly type: "uncaptured";
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `ompForkEntry` locates it in the session tree.
 */
function ompForkBoundary(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): OmpForkBoundary {
  const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
  const boundary = input.providerThreadTurns
    .filter((turn) => turn.ordinal > (target?.ordinal ?? 0) && turn.nativeTurnRef !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  const ref = boundary?.nativeTurnRef;
  if (boundary === undefined || ref == null) return { type: "nothing" };
  return ref.strength === "strong" && ref.nativeId !== null
    ? { type: "entry", entryId: ref.nativeId }
    : { type: "uncaptured", turn: boundary, target };
}

/** Reads the session tree only for an uncaptured boundary. */
function ompForkEntry<E>(
  boundary: Exclude<OmpForkBoundary, { type: "nothing" }>,
  providerThreadCreatedAt: DateTime.Utc,
  readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<
  { type: "fork" | "branch"; entryId: string },
  E | ProviderAdapter.ProviderAdapterProtocolError
> {
  return readEntries.pipe(
    Effect.flatMap((data) => {
      const listing = ompSessionListing(data);
      const excluded =
        boundary.type === "entry"
          ? boundary.entryId
          : listing === null
            ? undefined
            : ompUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
      if (listing === null || excluded === undefined || !listing.entries.has(excluded))
        return Effect.fail(
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OMP_PROVIDER,
            detail: "Missing oh-my-pi fork boundary",
          }),
        );
      const ancestry = walkOmpBranch(listing.entries, listing.leafId, excluded);
      if (!ancestry?.reachedStop)
        return Effect.fail(
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OMP_PROVIDER,
            detail: "Fork boundary is not on the active branch",
          }),
        );
      let cursor = listing.entries.get(excluded)!.parentId;
      const visited = new Set<string>();
      while (cursor !== null) {
        if (visited.has(cursor))
          return Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OMP_PROVIDER,
              detail: "Cyclic oh-my-pi session ancestry",
            }),
          );
        visited.add(cursor);
        const entry = listing.entries.get(cursor);
        if (entry === undefined)
          return Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OMP_PROVIDER,
              detail: "Incomplete oh-my-pi session ancestry",
            }),
          );
        // OMP includes the selected message and extends tool batches; the preceding completed message is safe.
        if (entry.isMessage)
          return Effect.succeed<{ type: "fork" | "branch"; entryId: string }>({
            type: "fork",
            entryId: cursor,
          });
        cursor = entry.parentId;
      }
      return Effect.succeed<{ type: "fork" | "branch"; entryId: string }>({
        type: "branch",
        entryId: excluded,
      });
    }),
  );
}

/**
 * Omp shares the server clock. An adopted wake can precede its U4 turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
function ompUncapturedForkEntry(
  listing: OmpSessionListing,
  boundary: Extract<OmpForkBoundary, { type: "uncaptured" }>,
  providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
  const { startedAt, completedAt } = boundary.turn;
  if (startedAt === null) return undefined;
  const from =
    boundary.target === null
      ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
      : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  const targetRef = boundary.target?.nativeTurnRef;
  const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
  if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
  const walk = walkOmpBranch(listing.entries, listing.leafId, stopAt);
  if (walk === null || !walk.reachedStop) return undefined;
  let earliest: string | undefined;
  for (const id of walk.userEntryIds) {
    const timestamp = listing.entries.get(id)?.timestamp;
    if (timestamp == null) return undefined;
    if (timestamp >= from && timestamp <= to) earliest = id;
  }
  return earliest;
}

function ompExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Omp extension";
  const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
  return name.length === 0 ? "Omp extension" : name;
}

function ompThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

function ompQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: OmpRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

function ompUiResponse(
  pending: PendingOmpPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): OmpRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | HttpClient.HttpClient
  | Path.Path;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Omp adapter.",
              cause,
            }),
        ),
      ),
  ),
};
