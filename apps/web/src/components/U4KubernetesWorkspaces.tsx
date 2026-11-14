import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type U4KubernetesWorkspace,
} from "@t3tools/contracts";
import { canUseKubernetesBootstrap } from "./U4KubernetesWorkspaces.logic";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { useState } from "react";
import { create } from "zustand";
import { u4Kubernetes } from "~/state/u4Kubernetes";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { connectPairing } from "~/connection/onboarding";
import { requestConfirmDialog } from "~/confirmDialog";
import { SettingsRow, SettingsSection } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogPopup,
} from "./ui/dialog";

const useRequest = create<{ projectRef: ScopedProjectRef | null }>(() => ({ projectRef: null }));
export function openKubernetesWorkspace(projectRef: ScopedProjectRef) {
  useRequest.setState({ projectRef });
}
export function U4KubernetesWorkspaces() {
  const { environments } = useEnvironments();
  return environments
    .filter((e) => e.serverConfig?.environment.capabilities.u4Kubernetes === true)
    .map((e) => <WorkspaceManager key={e.environmentId} environmentId={e.environmentId} />);
}
export function KubernetesWorkspaceDialogHost() {
  const projectRef = useRequest((s) => s.projectRef);
  return projectRef ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) useRequest.setState({ projectRef: null });
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Kubernetes workspace</DialogTitle>
          <DialogDescription>
            Create a retained remote workspace from this project's clean Git snapshot.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <WorkspaceManager
            environmentId={projectRef.environmentId}
            projectId={projectRef.projectId}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  ) : null;
}
function WorkspaceManager({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
}) {
  const canManage = useAtomValue(u4Kubernetes.launch.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canManage ? u4Kubernetes.list({ environmentId, input: {} }) : null,
  );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectId | null>(projectId ?? null);
  const [name, setName] = useState("concord");
  const [busy, setBusy] = useState(false);
  const launch = useAtomCommand(u4Kubernetes.launch);
  const profile = query.data?.profiles.find((p) => p.id === profileId) ?? query.data?.profiles[0];
  const project = projects.find((p) => p.id === selectedProject) ?? projects[0];
  if (!canManage) return null;
  return (
    <SettingsSection
      title="Kubernetes workspaces"
      headerAction={
        <Button variant="ghost" size="sm" onClick={query.refresh}>
          Refresh list
        </Button>
      }
    >
      {query.error ? (
        <SettingsRow title="Could not load workspaces" description={query.error} />
      ) : null}
      {query.data?.profiles.length === 0 ? (
        <SettingsRow
          title="No cluster profile configured"
          description="Add a profile in the managing environment's kubernetes/profiles.json. The cluster needs a dedicated namespace and retained storage."
        />
      ) : null}
      {profile ? (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <Select
              value={profile.id}
              onValueChange={setProfileId}
              items={query.data?.profiles.map((p) => ({ value: p.id, label: p.label }))}
            >
              <SelectTrigger aria-label="Kubernetes cluster">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {query.data?.profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={project?.id ?? null}
              onValueChange={(value) => setSelectedProject(value as ProjectId | null)}
              items={projects.map((p) => ({ value: p.id, label: p.title }))}
            >
              <SelectTrigger aria-label="Source project">
                <SelectValue placeholder="Source project" />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={busy || !project || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)}
              onClick={async () => {
                if (!project) return;
                setBusy(true);
                await launch({
                  environmentId,
                  input: { profileId: profile.id, projectId: project.id, name },
                });
                setBusy(false);
              }}
            >
              {busy ? "Preparing workspace…" : "Create workspace"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {profile.context} · {profile.namespace} · {profile.storageGiB} GiB retained. Container
            failures restart automatically; replacing a Pod requires approval.
          </p>
        </div>
      ) : null}
      {query.data?.workspaces.map((workspace) => (
        <WorkspaceRow key={workspace.id} environmentId={environmentId} workspace={workspace} />
      ))}
    </SettingsSection>
  );
}
function WorkspaceRow({
  environmentId,
  workspace,
}: {
  environmentId: EnvironmentId;
  workspace: U4KubernetesWorkspace;
}) {
  const lifecycle = useAtomCommand(u4Kubernetes.lifecycle);
  const connect = useAtomCommand(u4Kubernetes.connect);
  const pair = useAtomCommand(connectPairing);
  const exportResult = useAtomCommand(u4Kubernetes.export);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [head, setHead] = useState("");
  const [title, setTitle] = useState("");
  const [resultPath, setResultPath] = useState<string | null>(null);
  const act = async (
    action: "refresh" | "stop" | "restart" | "reattach" | "forget" | "restore",
  ) => {
    if (
      action === "restart" &&
      !(await requestConfirmDialog(
        `Bring ${workspace.name} back using its retained volume? The previous Pod must be gone and its node healthy.`,
      ))
    )
      return;
    if (
      action === "stop" &&
      !(await requestConfirmDialog(
        `Stop ${workspace.name}? Active work will be interrupted. Repository, identity, database and caches are retained.`,
      ))
    )
      return;
    if (
      action === "forget" &&
      !(await requestConfirmDialog(
        `Archive ${workspace.name}? Its recovery record and retained PVC ${workspace.pvcName} remain available here. Restore registration to use them again.`,
      ))
    )
      return;
    setBusy(true);
    await lifecycle({
      environmentId,
      input: {
        id: workspace.id,
        action,
        ...(action === "restart" ? { approveReplacement: true } : {}),
      },
    });
    setBusy(false);
  };
  const managerUrl = useEnvironmentHttpBaseUrl(environmentId);
  const primaryId = usePrimaryEnvironmentId();
  const canBootstrap = canUseKubernetesBootstrap({
    managerUrl,
    pageUrl: window.location.href,
    desktopManagedPrimary: window.desktopBridge !== undefined && primaryId === environmentId,
  });
  const connectVia = async (transport: "tailnet" | "forward") => {
    setBusy(true);
    const result = await connect({ environmentId, input: { id: workspace.id, transport } });
    if (result._tag === "Success" && result.value.route)
      await pair({
        host: result.value.route,
        pairingCode: result.value.pairingCode,
        expectedEnvironmentId: EnvironmentId.make(result.value.environmentId),
        ...(result.value.forwardExpiresAt
          ? { bootstrapExpiresAt: Date.parse(result.value.forwardExpiresAt) }
          : {}),
      });
    setBusy(false);
  };
  const canUseRoute =
    workspace.route !== null &&
    (window.location.protocol !== "https:" || workspace.route.startsWith("https:"));
  return (
    <div className="space-y-2 border-t p-4" data-testid="u4-workspace">
      <div className="font-medium">
        {workspace.name} · {workspace.status}{" "}
        {workspace.forgottenAt ? "(archived)" : "(saved status)"}
      </div>
      <div className="break-all text-xs text-muted-foreground">
        {workspace.profileId} · {workspace.podName} · {workspace.node ?? "Unassigned node"} ·{" "}
        {workspace.remotePath}
        <br />
        {workspace.route ?? "Tailnet route pending"}
        <br />
        Server restarts {workspace.serverRestarts} {workspace.serverRestartReason ?? ""} · Builder
        restarts {workspace.builderRestarts} {workspace.builderRestartReason ?? ""} · PVC{" "}
        {workspace.pvcName} · Environment {workspace.environmentId ?? "Pending"}
      </div>
      <p className="text-xs text-muted-foreground">
        {workspace.verifiedAt
          ? `Last verified ${workspace.verifiedAt}. Refresh status to check again.`
          : "Unverified saved record. Refresh status before relying on it."}
      </p>
      <WorkspaceActivity remoteEnvironmentId={workspace.environmentId} />
      {workspace.bootstrapExpiresAt ? (
        <p className="text-xs text-muted-foreground">
          Local bootstrap expires {workspace.bootstrapExpiresAt}.
        </p>
      ) : null}
      {!canUseRoute && workspace.route ? (
        <p className="text-xs text-muted-foreground">
          This HTTPS browser needs an HTTPS route. Use the desktop app or the workspace's own
          tailnet page for this HTTP endpoint.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("refresh")}>
          Refresh status
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canUseRoute || workspace.status !== "ready" || !!workspace.forgottenAt}
          onClick={() => connectVia("tailnet")}
        >
          Pair environment
        </Button>
        {canBootstrap ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || workspace.status !== "ready" || !!workspace.forgottenAt}
            onClick={() => connectVia("forward")}
          >
            {workspace.bootstrapExpiresAt ? "Reconnect local bootstrap" : "Use local bootstrap"}
          </Button>
        ) : null}
        {workspace.bootstrapExpiresAt ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await connect({
                environmentId,
                input: { id: workspace.id, transport: "stop-forward" },
              });
              setBusy(false);
            }}
          >
            Stop local bootstrap
          </Button>
        ) : null}
        {workspace.forgottenAt ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act("restore")}>
            Restore registration
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !!workspace.forgottenAt}
          onClick={() => act("reattach")}
        >
          Reattach
        </Button>
        {workspace.forgottenAt ? null : workspace.status === "stopped" ||
          workspace.status === "lost" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act("restart")}>
            Bring workspace back
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act("stop")}>
            Stop
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || workspace.status !== "ready" || !!workspace.forgottenAt}
          onClick={() => setExportOpen(!exportOpen)}
        >
          Return result
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || workspace.status !== "stopped"}
          onClick={() => act("forget")}
        >
          Archive registration
        </Button>
      </div>
      {exportOpen ? (
        <div className="space-y-2">
          <Input
            aria-label="Result branch"
            placeholder="Result branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
          <Input
            aria-label="Exact result SHA"
            placeholder="Exact result SHA"
            value={head}
            onChange={(e) => setHead(e.target.value)}
          />
          <Input
            aria-label="PR draft title"
            placeholder="PR draft title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            disabled={busy || !branch || !/^[a-f0-9]{40}$/.test(head) || !title}
            onClick={async () => {
              setBusy(true);
              const result = await exportResult({
                environmentId,
                input: {
                  id: workspace.id,
                  branch,
                  expectedHead: head,
                  title,
                  body: "Local draft. Review the verified diff and test evidence before approving publication.",
                },
              });
              if (result._tag === "Success") setResultPath(result.value.stagingPath);
              setBusy(false);
            }}
          >
            Verify and import locally
          </Button>
          <p className="text-xs text-muted-foreground">
            {resultPath
              ? `Verified staging: ${resultPath}. Nothing was published.`
              : "Returns a verified bundle and draft to the managing environment. Publishing requires separate exact-SHA and destination approval."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceActivity({ remoteEnvironmentId }: { remoteEnvironmentId: string | null }) {
  const remote = useEnvironment(
    remoteEnvironmentId === null ? null : EnvironmentId.make(remoteEnvironmentId),
  );
  const connected = remote?.connection.phase === "connected";
  const threads = useThreadShells(connected);
  const active = threads.filter(
    (thread) =>
      thread.environmentId === remoteEnvironmentId &&
      ["preparing", "starting", "running", "waiting"].includes(thread.latestRun?.status ?? ""),
  ).length;
  return (
    <div className="text-xs text-muted-foreground">
      Connection: {remote?.connection.phase ?? "not paired"} · Active turns:{" "}
      {connected ? active : "unknown"}
    </div>
  );
}
