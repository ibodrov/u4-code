import { it, expect } from "vite-plus/test";
import { PRODUCT_URL_SCHEME, PRODUCT_DEV_URL_SCHEME } from "@t3tools/shared/productIdentity";
import { canUseKubernetesBootstrap } from "./U4KubernetesWorkspaces.logic";
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
