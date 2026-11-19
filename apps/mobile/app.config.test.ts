import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_MOBILE_VERSION",
        "U4CODE_ANDROID_VERSION_CODE",
        "T3CODE_MOBILE_UPDATES_ENABLED",
        "T3CODE_MOBILE_UPDATES_URL",
        "T3CODE_EAS_PROJECT_ID",
        "T3CODE_EAS_OWNER",
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(
  variant: string | undefined,
  ...inputs: [] | [version: string | undefined, versionCode?: string | undefined]
) {
  const [version, versionCode] = inputs.length > 0 ? inputs : ["0.1.10-u4.8", "2026111501"];
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("T3CODE_MOBILE_VERSION", version);
  vi.stubEnv("U4CODE_ANDROID_VERSION_CODE", versionCode);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "ca.ibodrov.u4code.dev", "u4code-dev"],
  ["development", "ca.ibodrov.u4code.dev", "u4code-dev"],
  ["preview", "ca.ibodrov.u4code.preview", "u4code-preview"],
  ["production", "ca.ibodrov.u4code", "u4code"],
])("isolates the Android identity for APP_VARIANT=%j", async (value, identifier, scheme) => {
  const config = await loadConfig(value);
  expect(config.android?.package).toBe(identifier);
  expect(config.name).toMatch(/^U4 Code/);
  expect(config.scheme).toBe(scheme);
  expect(config.android?.intentFilters ?? []).toEqual([]);
  expect(config.ios?.associatedDomains ?? []).toEqual([]);
  expect(config.version).toBe("0.1.10-u4.8");
  expect(config.android?.versionCode).toBe(2026111501);
});

it.each([undefined, "development", "preview", "production"])(
  "keeps upstream OTA and EAS absent for APP_VARIANT=%j despite ambient T3 settings",
  async (variant) => {
    vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "1");
    vi.stubEnv("T3CODE_MOBILE_UPDATES_URL", "https://u.expo.dev/upstream");
    vi.stubEnv("T3CODE_EAS_PROJECT_ID", "upstream-project");
    vi.stubEnv("T3CODE_EAS_OWNER", "pingdotgg");
    const config = await loadConfig(variant);
    expect(config.updates).toEqual({ enabled: false });
    expect(config.extra?.eas?.projectId).toBeUndefined();
    expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
    expect(config.owner).toBeUndefined();
    expect(config.slug).toBe("u4code");
  },
);

it.each([undefined, "", "2.3.0", "0.1.10-u4.8\n", "../release", "0.1.10-u4.8 bad"])(
  "rejects production versionName=%j",
  async (version) => {
    await expect(loadConfig("production", version)).rejects.toThrow("T3CODE_MOBILE_VERSION");
  },
);

it.each([undefined, "", "0", "-1", "1.5", "1e3", "01", " 1", "1\n", "2100000000", "NaN"])(
  "rejects production versionCode=%j",
  async (versionCode) => {
    await expect(loadConfig("production", "0.1.10-u4.8", versionCode)).rejects.toThrow(
      "U4CODE_ANDROID_VERSION_CODE",
    );
  },
);

it.each(["1", "2099999999"])("accepts the Android versionCode boundary %s", async (value) => {
  expect((await loadConfig("production", "0.1.10-u4.8", value)).android?.versionCode).toBe(
    Number(value),
  );
});

it.each([undefined, "development", "preview"])(
  "uses a safe local version for APP_VARIANT=%j without release inputs",
  async (variant) => {
    const config = await loadConfig(variant, undefined, undefined);
    expect(config.extra?.appVariant).not.toBe("production");
    expect(config.version).toBe("0.0.0-u4.0");
    expect(config.android?.versionCode).toBe(1);
  },
);

it.each(["development", "preview"])("validates supplied counters for %s too", async (variant) => {
  await expect(loadConfig(variant, "0.1.10-u4.8", "-1")).rejects.toThrow(
    "U4CODE_ANDROID_VERSION_CODE",
  );
});
