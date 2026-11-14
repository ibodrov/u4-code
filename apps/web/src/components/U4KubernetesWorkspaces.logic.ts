import { U4_RESOURCE_NAME_PATTERN, type U4KubernetesWorkspace } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { PRODUCT_URL_SCHEME, PRODUCT_DEV_URL_SCHEME } from "@t3tools/shared/productIdentity";

export function canUseKubernetesBootstrap(input: {
  managerUrl: string | null;
  pageUrl: string;
  desktopManagedPrimary: boolean;
}) {
  if (!input.managerUrl) return false;
  const manager = new URL(input.managerUrl),
    page = new URL(input.pageUrl);
  if (!isLocalLoopbackHost(manager.hostname)) return false;
  return (
    (page.protocol === "http:" && isLocalLoopbackHost(page.hostname)) ||
    (input.desktopManagedPrimary &&
      page.host === "app" &&
      [PRODUCT_URL_SCHEME + ":", PRODUCT_DEV_URL_SCHEME + ":"].includes(page.protocol))
  );
}

const WORKSPACE_NAME_MAX_LENGTH = 63;
type ExistingWorkspace = Pick<U4KubernetesWorkspace, "name" | "profileId" | "forgottenAt">;

// Names are unique per cluster profile, and archived records keep theirs.
function namesOnProfile(workspaces: ReadonlyArray<ExistingWorkspace>, profileId: string) {
  return new Set(workspaces.filter((w) => w.profileId === profileId).map((w) => w.name));
}

function fitName(name: string, maxLength: number) {
  return name.slice(0, maxLength).replace(/-+$/, "");
}

function nextFreeName(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = fitName(base, WORKSPACE_NAME_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export function suggestWorkspaceName(input: {
  readonly projectTitle: string;
  readonly profileId: string;
  readonly workspaces: ReadonlyArray<ExistingWorkspace>;
}): string {
  const base =
    fitName(
      input.projectTitle
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, ""),
      WORKSPACE_NAME_MAX_LENGTH,
    ) || "workspace";
  return nextFreeName(base, namesOnProfile(input.workspaces, input.profileId));
}

export type WorkspaceNameProblem =
  | { readonly kind: "empty" | "too-long" | "uppercase" | "format" }
  | { readonly kind: "taken"; readonly archived: boolean; readonly alternative: string };

/** Mirrors the server's ResourceName rule; the server still decides. */
export function validateWorkspaceName(input: {
  readonly name: string;
  readonly profileId: string;
  readonly workspaces: ReadonlyArray<ExistingWorkspace>;
}): WorkspaceNameProblem | null {
  const { name } = input;
  if (name.length === 0) return { kind: "empty" };
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) return { kind: "too-long" };
  if (/[A-Z]/.test(name)) return { kind: "uppercase" };
  if (!U4_RESOURCE_NAME_PATTERN.test(name)) return { kind: "format" };
  const match = input.workspaces.find((w) => w.profileId === input.profileId && w.name === name);
  if (!match) return null;
  return {
    kind: "taken",
    archived: match.forgottenAt !== undefined,
    alternative: nextFreeName(name, namesOnProfile(input.workspaces, input.profileId)),
  };
}
