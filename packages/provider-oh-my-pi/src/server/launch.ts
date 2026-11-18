import type { RuntimeMode } from "@t3tools/contracts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const VALUE_FLAGS = new Set([
  "--profile",
  "--provider",
  "--model",
  "--thinking",
  "--tools",
  "--max-cost",
]);
const BOOLEAN_FLAGS = new Set([
  "--no-lsp",
  "--no-pty",
  "--no-prewalk",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
]);

export function resolveOmpLaunchArgs(
  text: string,
): { ok: true; args: string[] } | { ok: false; message: string } {
  let args: ReadonlyArray<string>;
  try {
    args = tokenizeCliArgs(text);
  } catch {
    return { ok: false, message: "Invalid launch argument quoting" };
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.split("=", 2);
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (!VALUE_FLAGS.has(flag!))
      return { ok: false, message: `Unsupported oh-my-pi launch flag: ${flag}` };
    const value = inline ?? args[++i];
    if (!value || value.startsWith("-")) return { ok: false, message: `Missing value for ${flag}` };
  }
  return { ok: true, args: [...args] };
}

export function buildOmpRpcLaunch(input: {
  launchArgs: readonly string[];
  environment: NodeJS.ProcessEnv;
  runtimeMode?: RuntimeMode;
  sessionDir?: string;
  ephemeral?: boolean;
  disableExtensions?: boolean;
  disableTools?: boolean;
  shortLived?: boolean;
}) {
  const approvalMode =
    input.runtimeMode === "full-access"
      ? "yolo"
      : input.runtimeMode === "auto-accept-edits"
        ? "write"
        : "always-ask";
  return {
    args: [
      ...input.launchArgs,
      "--mode",
      "rpc-ui",
      "--approval-mode",
      approvalMode,
      ...(input.sessionDir ? ["--session-dir", input.sessionDir] : []),
      ...(input.ephemeral ? ["--no-session"] : []),
      ...(input.disableExtensions ? ["--no-extensions"] : []),
      ...(input.disableTools ? ["--no-tools"] : []),
      "--no-title",
      "--append-system-prompt",
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    ],
    env: { ...input.environment },
  };
}
