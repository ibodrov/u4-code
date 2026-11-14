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
