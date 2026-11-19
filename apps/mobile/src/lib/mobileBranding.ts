import { applicationName } from "expo-application";
import { PRODUCT_BASE_NAME } from "@t3tools/shared/productIdentity";

export function resolveMobileBrandName(platform: string): string {
  return platform === "android" ? PRODUCT_BASE_NAME : "T3 Code";
}

export function resolveMobileSettingsAppName(platform: string): string {
  return platform === "android" ? applicationName || PRODUCT_BASE_NAME : "T3 Code";
}

export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}
