import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
const home = "/state/u4";
NodeFS.mkdirSync(`${home}/userdata`, { recursive: true });
const settings = `${home}/userdata/settings.json`;
// Reapply recovery policy before every start, including a start after a settings edit.
const value = NodeFS.existsSync(settings) ? JSON.parse(NodeFS.readFileSync(settings, "utf8")) : {};
value.continueThreadsAfterServerUpdate = false;
value.worktreesDirectory = "/workspace/worktrees";
for (const overrides of Object.values(value.projectSettingsOverrides ?? {}))
  delete overrides.continueThreadsAfterServerUpdate;
NodeFS.writeFileSync(`${settings}.next`, JSON.stringify(value));
NodeFS.renameSync(`${settings}.next`, settings);
const generation = process.env.U4_WORKSPACE_GENERATION;
if (!generation || NodeFS.readFileSync("/state/generation", "utf8").trim() !== generation)
  throw new Error("instance fenced");
const child = NodeChildProcess.spawn(
  "/opt/u4/runtime/t3",
  [
    "/workspace/repo",
    "--auto-bootstrap-project-from-cwd",
    "--base-dir",
    home,
    "--host",
    "0.0.0.0",
    "--port",
    "4773",
    "--no-browser",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      U4CODE_HOME: home,
      HOME: "/provider",
      PI_CODING_AGENT_DIR: "/provider/.pi/agent",
    },
  },
);
const fence = setInterval(() => {
  try {
    if (NodeFS.readFileSync("/state/generation", "utf8").trim() !== generation)
      child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}, 2000);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => {
  clearInterval(fence);
  process.exitCode = code ?? 1;
});
