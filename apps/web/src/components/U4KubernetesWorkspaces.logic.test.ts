import { it, expect } from "vite-plus/test";
import { PRODUCT_URL_SCHEME, PRODUCT_DEV_URL_SCHEME } from "@t3tools/shared/productIdentity";
import {
  canUseKubernetesBootstrap,
  suggestWorkspaceName,
  validateWorkspaceName,
  workspaceNameValue,
} from "./U4KubernetesWorkspaces.logic";
it("shows local bootstrap only for local web or the desktop's managed primary backend", () => {
  for (const scheme of [PRODUCT_URL_SCHEME, PRODUCT_DEV_URL_SCHEME]) {
    expect(
      canUseKubernetesBootstrap({
        managerUrl: "http://127.0.0.1:4773",
        pageUrl: `${scheme}://app/settings`,
        desktopManagedPrimary: true,
      }),
    ).toBe(true);
    expect(
      canUseKubernetesBootstrap({
        managerUrl: "http://127.0.0.1:4773",
        pageUrl: `${scheme}://app/settings`,
        desktopManagedPrimary: false,
      }),
    ).toBe(false);
  }
  for (const pageUrl of ["https://app.t3.codes", "unknown://app", "u4code://app.evil"])
    expect(
      canUseKubernetesBootstrap({
        managerUrl: "http://localhost:4773",
        pageUrl,
        desktopManagedPrimary: true,
      }),
    ).toBe(false);
  expect(
    canUseKubernetesBootstrap({
      managerUrl: "http://remote:4773",
      pageUrl: "http://localhost:8544",
      desktopManagedPrimary: false,
    }),
  ).toBe(false);
  expect(
    canUseKubernetesBootstrap({
      managerUrl: "http://localhost:4773",
      pageUrl: "http://localhost:8544",
      desktopManagedPrimary: false,
    }),
  ).toBe(true);
});

const existing = [
  { name: "payments-api", profileId: "local" },
  { name: "payments-api-2", profileId: "local", forgottenAt: "2026-11-01T00:00:00Z" },
  { name: "docs-site", profileId: "lab" },
];

it("suggests a cluster-unique name from the project title, counting archived workspaces", () => {
  const suggest = (projectTitle: string, profileId = "local") =>
    suggestWorkspaceName({ projectTitle, profileId, workspaces: existing });
  expect(suggest("Payments API")).toBe("payments-api-3");
  expect(suggest("Payments API", "lab")).toBe("payments-api");
  expect(suggest("Docs Site")).toBe("docs-site");
  expect(suggest("Docs Site", "lab")).toBe("docs-site-2");
  expect(suggest("  Café_Ünïcode! ")).toBe("cafe-unicode");
  expect(suggest("___")).toBe("workspace");
  const long = `${"a".repeat(60)}-bc`;
  expect(suggest(`${"a".repeat(62)}-bcd`)).toBe("a".repeat(62));
  expect(
    suggestWorkspaceName({
      projectTitle: long,
      profileId: "local",
      workspaces: [{ name: long, profileId: "local" }],
    }),
  ).toBe(`${"a".repeat(60)}-2`);
});

it("validates workspace names with the server's resource-name rule and per-cluster uniqueness", () => {
  const validate = (name: string, profileId = "local") =>
    validateWorkspaceName({ name, profileId, workspaces: existing });
  expect(validate("")).toEqual({ kind: "empty" });
  expect(validate("a".repeat(64))).toEqual({ kind: "too-long" });
  expect(validate("Payments")).toEqual({ kind: "uppercase" });
  for (const name of ["-api", "api-", "a_b", "a b"])
    expect(validate(name)).toEqual({ kind: "format" });
  expect(validate("payments-api")).toEqual({
    kind: "taken",
    archived: false,
    alternative: "payments-api-3",
  });
  expect(validate("payments-api-2")).toMatchObject({ kind: "taken", archived: true });
  expect(validate("payments-api", "lab")).toBeNull();
  expect(validate("a".repeat(63))).toBeNull();
});

it("pins a failed name only for its selection and never turns a suggestion into an edit", () => {
  const failed = { name: "payments-api", projectId: "p1", profileId: "local" };
  const value = (overrides: Partial<Parameters<typeof workspaceNameValue>[0]>) =>
    workspaceNameValue({
      draft: null,
      failed,
      projectId: "p1",
      profileId: "local",
      suggestion: "payments-api-2",
      ...overrides,
    });
  expect(value({})).toBe("payments-api");
  expect(value({ projectId: "p2", suggestion: "billing-service" })).toBe("billing-service");
  expect(value({ profileId: "lab", suggestion: "payments-api-lab" })).toBe("payments-api-lab");
  expect(value({ failed: null })).toBe("payments-api-2");
  expect(value({ draft: "mine", projectId: "p2" })).toBe("mine");
});
