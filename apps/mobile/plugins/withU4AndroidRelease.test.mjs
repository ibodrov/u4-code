import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { AndroidConfig, compileModsAsync } = require("expo/config-plugins");
const { getConfig } = require("expo/config");
const template = NodeChildProcess.execFileSync(
  "tar",
  [
    "-xOf",
    NodePath.join(NodePath.dirname(require.resolve("expo/package.json")), "template.tgz"),
    "package/android/app/build.gradle",
  ],
  { encoding: "utf8" },
);
const projectRoots = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildGradle(variant, contents = template) {
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("T3CODE_MOBILE_VERSION", "0.1.10-u4.8");
  vi.stubEnv("U4CODE_ANDROID_VERSION_CODE", "2026111501");
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "u4-release-plugin-"));
  projectRoots.push(projectRoot);
  const gradlePath = NodePath.join(projectRoot, "android/app/build.gradle");
  NodeFS.mkdirSync(NodePath.dirname(gradlePath), { recursive: true });
  NodeFS.writeFileSync(gradlePath, contents);
  delete require.cache[require.resolve("../app.config.ts")];
  const { exp } = getConfig(NodePath.resolve(import.meta.dirname, ".."), { isModdedConfig: true });
  const appBuildGradle = exp.mods?.android?.appBuildGradle;
  await compileModsAsync(
    AndroidConfig.Version.withVersion({
      ...exp,
      mods: { android: appBuildGradle ? { appBuildGradle } : {} },
    }),
    { projectRoot, platforms: ["android"] },
  );
  return NodeFS.readFileSync(gradlePath, "utf8");
}

it("generates an unsigned production Gradle project with the requested version and counter", async () => {
  const result = await prebuildGradle("production");
  expect(result).not.toMatch(
    /\b(?:signingConfigs?|storeFile|storePassword|keyAlias|keyPassword)\b/,
  );
  expect(result).toContain('versionName "0.1.10-u4.8"');
  expect(result).toContain("versionCode 2026111501");
  expect(result).toContain("minifyEnabled enableMinifyInReleaseBuilds");
  expect(await prebuildGradle("production", result)).toBe(result);
  const windowsTemplate = template
    .replaceAll("signingConfig signingConfigs.debug", "signingConfig = signingConfigs.debug")
    .replaceAll("\n", "\r\n");
  expect(await prebuildGradle("production", windowsTemplate)).not.toMatch(/\bsigningConfigs?\b/);
});

it("refuses an unrecognized signing block instead of producing a signed release", async () => {
  const changedTemplate = template.replace("signingConfigs {", "signingConfigs { /* changed */");
  await expect(prebuildGradle("production", changedTemplate)).rejects.toThrow(
    "still contains signing configuration",
  );
});

it.each(["development", "preview"])(
  "keeps local %s builds usable with template signing",
  async (variant) => {
    const result = await prebuildGradle(variant);
    expect(result).toContain("signingConfigs {");
    expect(result.match(/signingConfig signingConfigs.debug/g)).toHaveLength(2);
    expect(result).toContain("versionCode 2026111501");
  },
);
