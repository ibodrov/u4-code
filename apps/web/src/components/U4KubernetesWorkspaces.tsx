import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type U4ClusterProfile,
  type U4KubernetesWorkspace,
  U4WorkspaceError,
  type U4WorkspaceList,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  HardDriveIcon,
  ServerIcon,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { create } from "zustand";
import {
  canUseKubernetesBootstrap,
  suggestWorkspaceName,
  validateWorkspaceName,
  type WorkspaceNameProblem,
} from "./U4KubernetesWorkspaces.logic";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { u4Kubernetes } from "~/state/u4Kubernetes";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  type EnvironmentQueryView,
  formatEnvironmentQueryError,
  useEnvironmentQuery,
} from "~/state/query";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { connectPairing } from "~/connection/onboarding";
import { requestConfirmDialog } from "~/confirmDialog";
import { SettingsGroup } from "./settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "./settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
} from "./ui/dialog";

const useRequest = create<{ projectRef: ScopedProjectRef | null }>(() => ({ projectRef: null }));
export function openKubernetesWorkspace(projectRef: ScopedProjectRef) {
  useRequest.setState({ projectRef });
}
const closeKubernetesWorkspace = () => useRequest.setState({ projectRef: null });
const settingsTargetId = (environmentId: EnvironmentId) => `u4-kubernetes-${environmentId}`;

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
        if (!open) closeKubernetesWorkspace();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <WorkspaceDialogForm
          key={`${projectRef.environmentId}:${projectRef.projectId}`}
          projectRef={projectRef}
        />
      </DialogPopup>
    </Dialog>
  ) : null;
}
function WorkspaceDialogForm({ projectRef }: { projectRef: ScopedProjectRef }) {
  const { environmentId } = projectRef;
  const canManage = useAtomValue(u4Kubernetes.launch.permissionAtom(environmentId));
  const list = useEnvironmentQuery(
    canManage ? u4Kubernetes.list({ environmentId, input: {} }) : null,
  );
  return (
    <CreateWorkspaceForm
      environmentId={environmentId}
      fixedProjectId={projectRef.projectId}
      list={list}
      layout="dialog"
      canManage={canManage}
    />
  );
}
function WorkspaceManager({ environmentId }: { environmentId: EnvironmentId }) {
  const canManage = useAtomValue(u4Kubernetes.launch.permissionAtom(environmentId));
  const list = useEnvironmentQuery(
    canManage ? u4Kubernetes.list({ environmentId, input: {} }) : null,
  );
  if (!canManage) return null;
  const workspaces = list.data?.workspaces ?? [];
  return (
    <SettingsSection
      id={settingsTargetId(environmentId)}
      title="Kubernetes workspaces"
      headerAction={
        <Button variant="ghost" size="sm" onClick={list.refresh}>
          Refresh list
        </Button>
      }
    >
      <CreateWorkspaceForm environmentId={environmentId} list={list} layout="section" canManage />
      {workspaces.map((workspace) => (
        <WorkspaceRow key={workspace.id} environmentId={environmentId} workspace={workspace} />
      ))}
      {workspaces.length > 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Containers that fail restart automatically. Bringing a workspace back on new compute asks
          for your approval first.
        </p>
      ) : null}
    </SettingsSection>
  );
}

type FormLayout = "section" | "dialog";
type LaunchState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "creating";
      readonly name: string;
      readonly projectTitle: string;
      readonly clusterLabel: string;
    }
  | { readonly phase: "failed"; readonly notice: FailureNotice }
  | {
      readonly phase: "created";
      readonly workspace: U4KubernetesWorkspace;
      readonly clusterLabel: string;
    };
interface FailureNotice {
  readonly title: string;
  readonly body: string;
  readonly cluster?: U4ClusterProfile;
}

const isWorkspaceError = Schema.is(U4WorkspaceError);
// Result notices take focus so keyboard and screen reader users land on the outcome.
const focusOnMount = (node: HTMLElement | null) => node?.focus();

function describeLaunchFailure(
  cause: Cause.Cause<unknown>,
  context: {
    readonly name: string;
    readonly projectTitle: string;
    readonly profile: U4ClusterProfile;
    readonly environmentLabel: string;
    readonly layout: FormLayout;
  },
): FailureNotice {
  const { name, projectTitle, profile, environmentLabel } = context;
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  // Launch saves the record before any cluster step, so later failures can leave one behind.
  const checkRecord =
    context.layout === "section"
      ? `If ${name} appears in the list, refresh its status before you retry.`
      : `If ${name} appears in Settings, refresh its status there before you retry.`;
  switch (isWorkspaceError(error) ? error.stage : null) {
    case "name":
      return {
        title: `${name} is already used on ${profile.label}`,
        body: "Choose another name. Nothing was created.",
      };
    case "snapshot":
      return {
        title: `${projectTitle} can't be copied`,
        body: "Only a clean, committed checkout with no submodules, Git LFS files or tracked .env files can be copied. Nothing was created.",
      };
    case "configuration":
      return {
        title: `The ${profile.label} cluster profile can't be used`,
        body: `Check kubernetes/profiles.json on ${environmentLabel}, then try again.`,
      };
    case "cluster":
      return {
        title: `${profile.label} refused the workspace`,
        body: `Check that the cluster is reachable and has room, then try again. ${checkRecord}`,
        cluster: profile,
      };
    case "transfer":
      return {
        title: `${projectTitle} couldn't be copied`,
        body: `The source checkout wasn't changed. ${checkRecord}`,
      };
    case "storage":
      return {
        title: "The workspace record couldn't be saved",
        body: `Check the disk on ${environmentLabel}. ${checkRecord}`,
      };
    default:
      return {
        title: `${name} couldn't be created`,
        body: `${formatEnvironmentQueryError(cause)} ${checkRecord}`,
      };
  }
}

function nameProblemMessage(problem: WorkspaceNameProblem, name: string, clusterLabel: string) {
  switch (problem.kind) {
    case "empty":
      return "Enter a workspace name.";
    case "too-long":
      return "Use 63 characters or fewer.";
    case "uppercase":
      return "Use lowercase letters.";
    case "format":
      return "Use lowercase letters, numbers and hyphens. Start and end with a letter or number.";
    case "taken":
      return `${name} is already used on ${clusterLabel}${problem.archived ? " by an archived workspace" : ""}.`;
  }
}

function StaticValue({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

function ClusterDetails({ profile }: { profile: U4ClusterProfile }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        Cluster details
        <ChevronDownIcon
          aria-hidden
          className="size-3 transition-transform duration-200 group-data-panel-open:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pt-1.5">
          <dt>Context</dt>
          <dd className="break-all font-mono text-foreground">{profile.context}</dd>
          <dt>Namespace</dt>
          <dd className="break-all font-mono text-foreground">{profile.namespace}</dd>
          <dt>Storage class</dt>
          <dd className="break-all font-mono text-foreground">{profile.storageClass}</dd>
          <dt>Volume</dt>
          <dd className="text-foreground">
            {profile.storageGiB} GiB per workspace, kept after Stop or Archive
          </dd>
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function LaunchNotice({ state, layout }: { state: LaunchState; layout: FormLayout }) {
  switch (state.phase) {
    case "idle":
      return null;
    case "creating":
      return (
        <Alert variant="info" role="status">
          <Spinner aria-hidden="true" />
          <AlertTitle>
            Creating {state.name} on {state.clusterLabel}
          </AlertTitle>
          <AlertDescription>
            Copying {state.projectTitle} and starting the workspace. This can take a few minutes.
          </AlertDescription>
        </Alert>
      );
    case "failed":
      return (
        <Alert variant="error" controlAlignment="first-line" tabIndex={-1} ref={focusOnMount}>
          <CircleAlertIcon />
          <AlertTitle>{state.notice.title}</AlertTitle>
          <AlertDescription>
            <p>{state.notice.body}</p>
            {state.notice.cluster ? (
              <p>
                Context <code>{state.notice.cluster.context}</code> · namespace{" "}
                <code>{state.notice.cluster.namespace}</code>
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      );
    case "created": {
      const { workspace, clusterLabel } = state;
      const where = layout === "section" ? "its row in the list" : "Settings → Environments";
      return (
        <Alert
          variant="success"
          controlAlignment="first-line"
          role="status"
          tabIndex={-1}
          ref={focusOnMount}
        >
          <CircleCheckIcon />
          <AlertTitle>
            {workspace.status === "ready"
              ? `${workspace.name} is ready on ${clusterLabel}`
              : `${workspace.name} was created on ${clusterLabel}`}
          </AlertTitle>
          <AlertDescription>
            {workspace.status === "ready"
              ? `Pair it as an environment from ${where} to start threads in it.`
              : `Its saved status is ${workspace.status}. Refresh its status from ${where} before you pair it.`}
          </AlertDescription>
        </Alert>
      );
    }
  }
}

function CreateWorkspaceForm({
  environmentId,
  fixedProjectId,
  list,
  layout,
  canManage,
}: {
  environmentId: EnvironmentId;
  fixedProjectId?: ProjectId;
  list: EnvironmentQueryView<U4WorkspaceList, unknown>;
  layout: FormLayout;
  canManage: boolean;
}) {
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const environmentLabel = useEnvironment(environmentId)?.label ?? "the managing environment";
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  // null keeps following the suggestion; any edit pins the user's text.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>({ phase: "idle" });
  const launch = useAtomCommand(u4Kubernetes.launch, { reportFailure: false });

  const profiles = list.data?.profiles ?? [];
  const workspaces = list.data?.workspaces ?? [];
  const profile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0];
  const project =
    fixedProjectId === undefined
      ? (projects.find((p) => p.id === selectedProjectId) ?? projects[0])
      : projects.find((p) => p.id === fixedProjectId);
  const suggestion =
    project && profile
      ? suggestWorkspaceName({ projectTitle: project.title, profileId: profile.id, workspaces })
      : "";
  const name = nameDraft ?? suggestion;
  const nameProblem = profile
    ? validateWorkspaceName({ name, profileId: profile.id, workspaces })
    : null;
  const busy = launchState.phase === "creating";
  const blockedReason = !project
    ? fixedProjectId === undefined
      ? `Add a project on ${environmentLabel} first.`
      : `This project is no longer on ${environmentLabel}.`
    : nameProblem
      ? "Fix the workspace name to continue."
      : null;

  const clearOutcome = () => {
    if (launchState.phase === "failed" || launchState.phase === "created")
      setLaunchState({ phase: "idle" });
  };
  const submit = async () => {
    if (busy || blockedReason !== null || !project || !profile) return;
    setLaunchState({
      phase: "creating",
      name,
      projectTitle: project.title,
      clusterLabel: profile.label,
    });
    const result = await launch({
      environmentId,
      input: { profileId: profile.id, projectId: project.id, name },
    });
    if (result._tag === "Success") {
      setNameDraft(null);
      setLaunchState({ phase: "created", workspace: result.value, clusterLabel: profile.label });
    } else if (isAtomCommandInterrupted(result)) {
      setLaunchState({ phase: "idle" });
    } else {
      setNameDraft(name);
      setLaunchState({
        phase: "failed",
        notice: describeLaunchFailure(result.cause, {
          name,
          projectTitle: project.title,
          profile,
          environmentLabel,
          layout,
        }),
      });
    }
  };

  const unavailable = !canManage ? (
    <SettingsRow
      title="Kubernetes workspaces aren't available"
      description={`This connection can't create Kubernetes workspaces on ${environmentLabel}.`}
    />
  ) : list.data === null && list.error !== null ? (
    <SettingsRow title="Could not load clusters" description={list.error} />
  ) : list.data === null ? (
    <div aria-busy="true" className="space-y-2.5 px-3 py-4 sm:px-4">
      <p className="text-xs text-muted-foreground">Loading clusters…</p>
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-2 w-3/5" />
    </div>
  ) : profiles.length === 0 ? (
    <SettingsRow
      title={`No cluster set up on ${environmentLabel}`}
      description={`Add a cluster profile to kubernetes/profiles.json on ${environmentLabel}. The cluster needs a dedicated namespace and retained storage.`}
    />
  ) : null;

  const sourceRow = (
    <SettingsRow
      title={<span id={`${id}-source`}>Source project</span>}
      description={
        <span id={`${id}-source-help`}>
          Its last commit is copied once. Uncommitted and ignored files stay on {environmentLabel}.
        </span>
      }
      control={
        fixedProjectId !== undefined || projects.length === 0 ? (
          <StaticValue icon={<FolderIcon aria-hidden />}>
            {project?.title ?? `No projects on ${environmentLabel}`}
          </StaticValue>
        ) : (
          <Select
            value={project?.id ?? null}
            disabled={busy}
            onValueChange={(value) => {
              setSelectedProjectId(value as ProjectId | null);
              clearOutcome();
            }}
            items={projects.map((p) => ({ value: p.id, label: p.title }))}
          >
            <SelectTrigger aria-labelledby={`${id}-source`} aria-describedby={`${id}-source-help`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )
      }
    />
  );
  const clusterRow = profile ? (
    <SettingsRow
      title={<span id={`${id}-cluster`}>Cluster</span>}
      description={
        <span id={`${id}-cluster-help`}>
          Where the workspace runs.{" "}
          {profiles.length === 1
            ? `The only cluster set up on ${environmentLabel}.`
            : `Clusters are set up on ${environmentLabel}.`}
        </span>
      }
      status={<ClusterDetails profile={profile} />}
      control={
        profiles.length === 1 ? (
          <StaticValue icon={<ServerIcon aria-hidden />}>{profile.label}</StaticValue>
        ) : (
          <Select
            value={profile.id}
            disabled={busy}
            onValueChange={(value) => {
              setSelectedProfileId(value);
              clearOutcome();
            }}
            items={profiles.map((p) => ({ value: p.id, label: p.label }))}
          >
            <SelectTrigger
              aria-labelledby={`${id}-cluster`}
              aria-describedby={`${id}-cluster-help`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )
      }
    />
  ) : null;
  const nameMessage =
    nameProblem && profile ? nameProblemMessage(nameProblem, name, profile.label) : null;
  const nameRow =
    project && profile ? (
      <SettingsRow
        title={<Label htmlFor={`${id}-name`}>Workspace name</Label>}
        description={
          <span id={`${id}-name-help`}>
            Identifies the workspace in lists and when you pair it.
          </span>
        }
        status={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              id={`${id}-name-hint`}
              aria-live="polite"
              className={nameMessage ? "text-destructive-foreground" : undefined}
            >
              {nameMessage ??
                (nameDraft === null
                  ? `Suggested from ${project.title}. You can change it.`
                  : name === suggestion
                    ? `Suggested from ${project.title}.`
                    : "Lowercase letters, numbers and hyphens.")}
            </span>
            {nameProblem?.kind === "taken" ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setNameDraft(nameProblem.alternative);
                  clearOutcome();
                  nameInput.current?.focus();
                }}
              >
                Use {nameProblem.alternative}
              </Button>
            ) : null}
          </div>
        }
        control={
          <Input
            ref={nameInput}
            id={`${id}-name`}
            value={name}
            disabled={busy}
            onChange={(event) => {
              setNameDraft(event.target.value);
              clearOutcome();
            }}
            onBlur={() => {
              if (nameDraft !== null && nameDraft.trim() === "") setNameDraft(null);
            }}
            aria-invalid={nameProblem !== null || undefined}
            aria-describedby={`${id}-name-help ${id}-name-hint`}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        }
      />
    ) : null;
  const whatHappens =
    project && profile ? (
      <div className="space-y-1.5 px-3 py-3 sm:px-4">
        <h3 id={`${id}-happens`} className="text-sm font-medium text-foreground">
          What happens
        </h3>
        <ul
          aria-labelledby={`${id}-happens`}
          className="space-y-1.5 text-xs leading-normal text-muted-foreground [&_li]:flex [&_li]:gap-2 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0"
        >
          <li>
            <GitCommitHorizontalIcon aria-hidden />
            <span>
              Copies the last commit of {project.title} once. Later changes on {environmentLabel}{" "}
              aren't synced. Bring work back with Return result.
            </span>
          </li>
          <li>
            <ServerIcon aria-hidden />
            <span>Starts compute on {profile.label}.</span>
          </li>
          <li>
            <HardDriveIcon aria-hidden />
            <span>
              Keeps a {profile.storageGiB} GiB volume. It stays when you stop or archive the
              workspace, and only a cluster administrator can delete it.
            </span>
          </li>
        </ul>
      </div>
    ) : null;
  const reason = (
    <p id={`${id}-reason`} className="self-center text-xs text-muted-foreground sm:me-auto">
      {busy ? null : (blockedReason ?? "This can take a few minutes.")}
    </p>
  );
  const createButton = (
    <Button
      type="submit"
      disabled={busy || blockedReason !== null}
      aria-describedby={`${id}-reason`}
    >
      {busy ? <Spinner aria-hidden="true" /> : null}
      {busy ? "Creating workspace…" : "Create workspace"}
    </Button>
  );
  const notice = <LaunchNotice state={launchState} layout={layout} />;
  const onSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    void submit();
  };

  if (layout === "section") {
    return (
      unavailable ?? (
        <form
          aria-label="New Kubernetes workspace"
          aria-busy={busy}
          noValidate
          onSubmit={onSubmit}
          className="divide-y divide-border/50"
        >
          {launchState.phase === "idle" ? null : <div className="px-3 py-3 sm:px-4">{notice}</div>}
          {sourceRow}
          {clusterRow}
          {nameRow}
          {whatHappens}
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
            {reason}
            {createButton}
          </div>
        </form>
      )
    );
  }
  const created = launchState.phase === "created";
  return (
    <form aria-busy={busy} noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>New Kubernetes workspace</DialogTitle>
        <DialogDescription>
          Run {project?.title ?? "this project"} on a cluster, starting from a one-time copy of its
          last commit.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {unavailable ? (
          <SettingsGroup>{unavailable}</SettingsGroup>
        ) : (
          <>
            {notice}
            {created ? null : (
              <SettingsGroup>
                {sourceRow}
                {clusterRow}
                {nameRow}
                {whatHappens}
              </SettingsGroup>
            )}
          </>
        )}
        <Button
          variant="link"
          size="xs"
          render={<Link to="/settings/connections" hash={settingsTargetId(environmentId)} />}
          onClick={closeKubernetesWorkspace}
        >
          Manage in Settings
        </Button>
      </DialogPanel>
      <DialogFooter>
        {unavailable || created ? (
          <Button type="button" variant="outline" onClick={closeKubernetesWorkspace}>
            {created ? "Done" : "Close"}
          </Button>
        ) : (
          <>
            {reason}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeKubernetesWorkspace}
            >
              Cancel
            </Button>
            {createButton}
          </>
        )}
      </DialogFooter>
    </form>
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
