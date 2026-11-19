import { useEffect, useEffectEvent, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as C from "@t3tools/contracts";
import { createT3ImportCommands } from "@t3tools/client-runtime/state/u4T3Import";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  emptyImportSelection,
  selectImportProject,
  selectImportThread,
  importThreadSelected,
  canPreviewImport,
} from "./t3ImportWizard.logic";

const commands = createT3ImportCommands(connectionAtomRuntime);
const sections = C.T3ImportSection.literals;

export function T3ImportSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const environment = connectedEnvironments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection title="Import from T3 Code" id="t3-import" variant="plain">
        {environment?.serverConfig?.environment.capabilities.u4T3Import === true ? (
          <ImportWizard
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ) : (
          <p>Choose a connected environment that supports importing from T3 Code.</p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ImportWizard({ environmentId, label }: { environmentId: C.EnvironmentId; label: string }) {
  const canMaintain = useAtomValue(commands.open.permissionAtom(environmentId));
  const open = useAtomCommand(commands.open),
    getSession = useAtomCommand(commands.getSession, { reportFailure: false });
  const listThreads = useAtomCommand(commands.listThreads),
    preview = useAtomCommand(commands.preview);
  const previewPage = useAtomCommand(commands.previewPage),
    start = useAtomCommand(commands.start);
  const getJob = useAtomCommand(commands.getJob, { reportFailure: false }),
    cancel = useAtomCommand(commands.cancel),
    close = useAtomCommand(commands.close);
  const destinationProjectValue = (sourceProjectId: C.ProjectId) => {
    const mapping = selection.projectMapping.find(
      (mapping) => mapping.sourceProjectId === sourceProjectId,
    )?.destination;
    return mapping?.type === "existing" ? mapping.projectId : "create";
  };
  const [sourceHome, setSourceHome] = useState("~/.t3");
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const browse = useEnvironmentQuery(
    browsePath && canMaintain
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: browsePath } })
      : null,
  );
  const [session, setSession] = useState<C.T3ImportSession | null>(null);
  const [project, setProject] = useState<C.ProjectId | null>(null);
  const [threads, setThreads] = useState<ReadonlyArray<typeof C.T3ImportThread.Type>>([]);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [selection, setSelection] = useState(emptyImportSelection);
  const [plan, setPlan] = useState<C.T3ImportPreview | null>(null);
  const [section, setSection] = useState<C.T3ImportSection>("threads");
  const [page, setPage] = useState<C.T3ImportPage | null>(null);
  const [job, setJob] = useState<C.T3ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const running = job?.status === "running" || job?.status === "cancelling";
  const value = <A, E>(result: AtomCommandResult<A, E>): A | null => {
    if (result._tag === "Success") return result.value;
    const cause = squashAtomCommandFailure(result);
    setError(
      cause instanceof Error
        ? cause.message
        : "The import operation failed. Refresh its status before trying again.",
    );
    return null;
  };
  const refresh = useEffectEvent(async () => {
    if (session?.status === "preparing") {
      const next = value(
        await getSession({ environmentId, input: { sessionId: session.sessionId } }),
      );
      if (next) setSession(next);
    }
    if (running && job) {
      const next = value(await getJob({ environmentId, input: { jobId: job.jobId } }));
      if (next) setJob(next);
    }
  });
  const reconnect = useEffectEvent(
    async (targetEnvironmentId: C.EnvironmentId, isActive: () => boolean) => {
      const result = await getSession({ environmentId: targetEnvironmentId, input: {} });
      if (!isActive() || result._tag !== "Success") return;
      setSession(result.value);
      const latest = await getJob({ environmentId: targetEnvironmentId, input: {} });
      if (isActive() && latest._tag === "Success") setJob(latest.value);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconnect to the environment-owned session when this page opens
  useEffect(() => {
    if (!canMaintain) return;
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- asynchronous RPC restores server-owned state after reconnect
    void reconnect(environmentId, () => active);
    return () => {
      active = false;
    };
  }, [environmentId, canMaintain]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll only while server staging or an import job is running and this page is mounted
  useEffect(() => {
    if (session?.status !== "preparing" && !running) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [session?.status, running]);
  const act = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    await operation().then(
      () => setPending(false),
      (cause: unknown) => {
        setPending(false);
        setError(cause instanceof Error ? cause.message : "The import operation failed.");
      },
    );
  };
  const showThreads = async (projectId: C.ProjectId, cursor?: string) => {
    if (!session) return;
    const next = value(
      await listThreads({
        environmentId,
        input: {
          sessionId: session.sessionId,
          sourceProjectId: projectId,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );
    if (next) {
      setProject(projectId);
      setThreads(next.threads);
      setThreadCursor(next.nextCursor);
    }
  };
  const showPreview = async (nextSelection = selection) => {
    if (!session) return;
    const next = value(
      await preview({
        environmentId,
        input: { sessionId: session.sessionId, selection: nextSelection },
      }),
    );
    if (next) {
      setPlan(next);
      setSection("threads");
      setPage(next.sections.threads);
    }
  };
  const reset = async () => {
    if (session) {
      const result = await close({ environmentId, input: { sessionId: session.sessionId } });
      if (result._tag !== "Success") {
        value(result);
        return;
      }
    }
    setSession(null);
    setJob(null);
    setPlan(null);
    setPage(null);
    setThreads([]);
    setSelection(emptyImportSelection());
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Import individual threads, part of a project, or whole projects from a T3 home on {label}.
        The source is read-only. Imported histories stay inactive until you send a new message.
      </p>
      {!canMaintain && (
        <p role="status">This connection needs environment maintenance permission.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!session && (
        <div className="space-y-3">
          <label className="block space-y-2">
            <span>Source T3 home on {label}</span>
            <Input
              aria-label="Source T3 home"
              value={sourceHome}
              onChange={(e) => setSourceHome(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!canMaintain || pending}
              onClick={() => setBrowsePath(sourceHome.replace(/\/$/, "") + "/")}
            >
              Browse server folders
            </Button>
            <Button
              disabled={!canMaintain || pending || !sourceHome.trim()}
              onClick={() =>
                void act(async () => {
                  const opened = value(await open({ environmentId, input: { sourceHome } }));
                  if (opened) {
                    const next = value(await getSession({ environmentId, input: opened }));
                    if (next) setSession(next);
                  }
                })
              }
            >
              Read source
            </Button>
          </div>
          {browsePath && (
            <div className="space-y-2 rounded border p-3">
              <p className="break-all text-sm">{browse.data?.parentPath ?? browsePath}</p>
              {browse.error && <p role="alert">{browse.error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setBrowsePath(browsePath.replace(/\/$/, "").replace(/\/[^/]*$/, "") + "/")
                  }
                >
                  Parent folder
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSourceHome(browse.data?.parentPath ?? browsePath);
                    setBrowsePath(null);
                  }}
                >
                  Use this folder
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setBrowsePath(null)}>
                  Close browser
                </Button>
              </div>
              <ul>
                {browse.data?.entries.map((entry) => (
                  <li key={entry.fullPath}>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => {
                        setSourceHome(entry.fullPath);
                        setBrowsePath(entry.fullPath + "/");
                      }}
                    >
                      {entry.name}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {session?.status === "preparing" && <p role="status">Preparing a private source snapshot…</p>}
      {session?.status === "failed" && (
        <p role="alert">{session.error?.message ?? "Source preparation failed."}</p>
      )}
      {session?.status === "ready" && !plan && !job && (
        <div className="space-y-4">
          <p className="text-sm break-all">
            Source: {session.source?.home} · schema {session.source?.schemaHead}
          </p>
          <h3 className="font-medium">Select history</h3>
          <ul className="space-y-3">
            {session.projects.map((p) => (
              <li key={p.id} className="space-y-2 rounded border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selection.projectIds.includes(p.id)}
                      onChange={(e) =>
                        setSelection(selectImportProject(selection, p.id, e.target.checked))
                      }
                    />
                    {p.title} ({p.threadCount} threads, including archived)
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void act(() => showThreads(p.id))}
                  >
                    Choose threads
                  </Button>
                </div>
                <p className="text-xs break-all text-muted-foreground">{p.workspaceRoot}</p>
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  Destination project
                  <select
                    aria-label={`Destination for ${p.title}`}
                    value={destinationProjectValue(p.id)}
                    onChange={(e) =>
                      setSelection({
                        ...selection,
                        projectMapping: [
                          ...selection.projectMapping.filter((m) => m.sourceProjectId !== p.id),
                          {
                            sourceProjectId: p.id,
                            destination:
                              e.target.value === "create"
                                ? { type: "create" }
                                : { type: "existing", projectId: C.ProjectId.make(e.target.value) },
                          },
                        ],
                      })
                    }
                  >
                    <option value="create">Match workspace root, otherwise create</option>
                    {projects.map((dest) => (
                      <option key={dest.id} value={dest.id}>
                        {dest.title}
                      </option>
                    ))}
                  </select>
                </label>
                {project === p.id && (
                  <div className="space-y-2 border-t pt-2">
                    <ul className="space-y-2">
                      {threads.map((thread) => (
                        <li key={thread.id}>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={importThreadSelected(selection, p.id, thread.id)}
                              onChange={(e) =>
                                setSelection(
                                  selectImportThread(selection, p.id, thread.id, e.target.checked),
                                )
                              }
                            />
                            {thread.title} · {thread.runCount} runs · {thread.itemCount} items
                            {thread.archived ? " · archived" : ""}
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void act(() => showThreads(p.id))}
                      >
                        First page
                      </Button>
                      {threadCursor && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => void act(() => showThreads(p.id, threadCursor))}
                        >
                          Next 100 threads
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {session.nextProjectCursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const next = value(
                    await getSession({
                      environmentId,
                      input: {
                        sessionId: session.sessionId,
                        projectCursor: session.nextProjectCursor!,
                      },
                    }),
                  );
                  if (next) setSession(next);
                })
              }
            >
              Next 100 projects
            </Button>
          )}
          <Button
            disabled={!canMaintain || pending || !canPreviewImport(selection)}
            onClick={() => void act(() => showPreview())}
          >
            Preview import
          </Button>
        </div>
      )}
      {plan && !job && (
        <div className="space-y-4">
          <h3 className="font-medium">Preview</h3>
          <p className="text-sm text-muted-foreground">
            Destination mappings apply to new copies. Skipped copies keep their existing project and
            ancestor generations.
          </p>
          <p className="text-sm">
            {plan.totals.importing} threads to import · {plan.totals.skipped} units skipped ·{" "}
            {plan.totals.blocked} units blocked · {plan.totals.items} timeline items ·{" "}
            {plan.totals.runs} runs · {plan.totals.mcpContexts} MCP context rows ·{" "}
            {plan.totals.assets} asset references
          </p>
          <nav className="flex flex-wrap gap-2" aria-label="Preview sections">
            {sections.map((name) => (
              <Button
                key={name}
                variant={section === name ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSection(name);
                  setPage(plan.sections[name]);
                }}
              >
                {name} ({plan.sections[name].count})
              </Button>
            ))}
          </nav>
          <ul className="space-y-3">
            {page?.rows.map((row) => (
              <li
                key={row.id ?? JSON.stringify(row)}
                className="space-y-1 rounded border p-3 text-sm"
              >
                <p className="font-medium">
                  {row.title ?? row.sourceThreadId ?? row.category} · {row.category}
                  {row.count !== undefined ? ` (${row.count})` : ""}
                </p>
                <p className="break-all">{row.explanation}</p>
                {row.destinationThreadId && (
                  <p className="break-all text-xs text-muted-foreground">
                    Destination: {row.destinationThreadId}
                  </p>
                )}
                {row.unitRootThreadId &&
                  ["changed-since-import", "dependency-changed", "copy-incomplete"].includes(
                    row.category,
                  ) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void act(async () => {
                          const next = {
                            ...selection,
                            newCopyUnitRootIds: [
                              ...new Set([...selection.newCopyUnitRootIds, row.unitRootThreadId!]),
                            ],
                          };
                          setSelection(next);
                          await showPreview(next);
                        })
                      }
                    >
                      Import as new copy
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          {page?.nextCursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const next = value(
                    await previewPage({
                      environmentId,
                      input: { planId: plan.planId, section, cursor: page.nextCursor! },
                    }),
                  );
                  if (next) setPage(next);
                })
              }
            >
              Next 100 rows
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setPlan(null);
                setPage(null);
              }}
            >
              Edit selection
            </Button>
            <Button
              disabled={!canMaintain || pending || !plan.totals.importing}
              onClick={() =>
                void act(async () => {
                  if (!session) return;
                  const started = value(
                    await start({
                      environmentId,
                      input: { sessionId: session.sessionId, planId: plan.planId },
                    }),
                  );
                  if (started) {
                    const next = value(await getJob({ environmentId, input: started }));
                    if (next) setJob(next);
                  }
                })
              }
            >
              Import selected history
            </Button>
          </div>
        </div>
      )}
      {job && (
        <div className="space-y-3">
          <h3 className="font-medium">{running ? "Importing history" : "Import results"}</h3>
          <p role="status">
            {job.status} · {job.progress.completed} of {job.progress.total} threads processed
          </p>
          <ul className="space-y-2">
            {job.results.map((result) => (
              <li key={result.sourceThreadId} className="rounded border p-3 text-sm break-all">
                {result.sourceThreadId}: {result.outcome} · {result.reason}
                {result.unavailableLinks
                  ? ` · ${result.unavailableLinks} unavailable historical links`
                  : ""}
                {result.destinationThreadId &&
                  (result.outcome === "imported" || result.reason === "already-imported") && (
                    <div>
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(environmentId, result.destinationThreadId),
                        )}
                        className="underline underline-offset-2"
                      >
                        Open imported history
                      </Link>
                    </div>
                  )}
              </li>
            ))}
          </ul>
          {job.unavailableLinkRows.length > 0 && (
            <div>
              <h4 className="font-medium">Unavailable historical links</h4>
              <ul className="space-y-2">
                {job.unavailableLinkRows.map((row) => (
                  <li
                    key={`${row.sourceThreadId}:${row.destinationThreadId}`}
                    className="rounded border p-3 text-sm break-all"
                  >
                    {row.sourceThreadId} → {row.destinationThreadId}: {row.count} links.{" "}
                    {row.explanation}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.nextCursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const next = value(
                    await getJob({
                      environmentId,
                      input: { jobId: job.jobId, cursor: job.nextCursor! },
                    }),
                  );
                  if (next) setJob(next);
                })
              }
            >
              Next 100 results
            </Button>
          )}
          {running && (
            <Button
              variant="outline"
              disabled={pending || job.status === "cancelling"}
              onClick={() =>
                void act(async () => {
                  const cancelled = value(
                    await cancel({ environmentId, input: { jobId: job.jobId } }),
                  );
                  if (cancelled) setJob({ ...job, status: cancelled.status });
                })
              }
            >
              Cancel after the current unit
            </Button>
          )}
          {job.status === "unknown" && (
            <p>
              One unit has an unresolved database outcome. Its journal and private files are
              retained for reconciliation; later units were not started.
            </p>
          )}
        </div>
      )}
      {session && !running && (
        <Button variant="outline" disabled={pending} onClick={() => void act(reset)}>
          Close source and start again
        </Button>
      )}
    </div>
  );
}
