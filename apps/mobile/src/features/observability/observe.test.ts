import * as NodeModule from "node:module";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

function setup(extra: Record<string, unknown>, loadError?: Error) {
  vi.resetModules();
  vi.stubGlobal("__DEV__", false);
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rejectionTracker = vi.fn();
  vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: rejectionTracker });
  onTestFinished(() => {
    warnings.mockRestore();
    vi.unstubAllGlobals();
  });

  const preferences = Promise.withResolvers<{ crashReportsEnabled?: boolean }>();
  const preferencesRequested = Promise.withResolvers<void>();
  const configured = Promise.withResolvers<void>();
  const sdk = {
    configure: vi.fn((_config: { dispatchingEnabled: boolean; environment?: string }) => {
      configured.resolve();
    }),
    dispatchEvents: vi.fn(async () => {}),
    reportError: vi.fn((_error: unknown) => {}),
  };
  // Model the pinned SDK's native OnCreate check at module load, before configure can run.
  const loadNativeSdk = vi.fn(() => {
    const projectId = (extra.eas as { projectId?: unknown } | undefined)?.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("Project ID is required to send observability metrics.");
    }
    if (loadError) throw loadError;
    return { Observe: sdk };
  });
  vi.doMock("expo-constants", () => ({ default: { expoConfig: { extra } } }));
  vi.doMock("expo-observe", loadNativeSdk);
  // Vitest mocks ESM imports; Metro's conditional require needs the same fixture in Node's cache.
  const require = NodeModule.createRequire(import.meta.url);
  const nativePath = require.resolve("expo-observe");
  const previousNative = require.cache[nativePath];
  const nativeFixture = new NodeModule.Module(nativePath);
  nativeFixture.loaded = true;
  Object.defineProperty(nativeFixture, "exports", { get: loadNativeSdk });
  require.cache[nativePath] = nativeFixture;
  onTestFinished(() => {
    if (previousNative) require.cache[nativePath] = previousNative;
    else delete require.cache[nativePath];
  });
  vi.doMock("../../persistence/imperative", () => ({
    loadPreferences: () => {
      preferencesRequested.resolve();
      return preferences.promise;
    },
  }));
  vi.doMock("react-native", () => ({ ScrollView: "ScrollView", View: "View" }));
  vi.doMock("../../components/ui/AppText", () => ({ AppText: "AppText" }));
  vi.doMock("../../components/ui/Button", () => ({ Button: "Button" }));
  vi.doMock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
  return {
    sdk,
    loadNativeSdk,
    preferences,
    preferencesRequested: preferencesRequested.promise,
    configured: configured.promise,
    rejectionTracker,
    warnings,
  };
}

const configuredExtra = {
  relay: { url: "https://relay.example.test" },
  eas: { projectId: "owned-project" },
  appVariant: "production",
};

it.each([
  {},
  { ...configuredExtra, eas: undefined },
  { ...configuredExtra, eas: { projectId: null } },
  { ...configuredExtra, eas: { projectId: " " } },
  { ...configuredExtra, eas: { projectId: 123 } },
  { ...configuredExtra, relay: undefined },
  { ...configuredExtra, relay: { url: "" } },
  { ...configuredExtra, relay: { url: " " } },
])("boots without loading the native SDK for incomplete config %j", async (extra) => {
  const h = setup(extra);
  const observe = await import("./observe");
  expect(observe.crashReportingAvailable).toBe(false);
  await observe.setCrashReportsEnabled(true);
  await observe.setCrashReportsEnabled(false);
  expect(h.loadNativeSdk).not.toHaveBeenCalled();
  expect(h.rejectionTracker).not.toHaveBeenCalled();
});

it("imports the render boundary independently without optional native configuration", async () => {
  const h = setup({});
  const { RenderErrorBoundary } = await import("../../components/RenderErrorBoundary");
  const boundary = new RenderErrorBoundary({ children: null });
  const update = vi.spyOn(boundary, "setState").mockImplementation(() => {});
  boundary.componentDidCatch(new Error("render failed"), { componentStack: "at Screen" });
  expect(update).toHaveBeenCalledWith({ componentStack: "at Screen" });
  expect(h.loadNativeSdk).not.toHaveBeenCalled();
});

it.each([false, true, undefined])(
  "restores the configured crash report preference %s without an early disable",
  async (crashReportsEnabled) => {
    const h = setup(configuredExtra);
    const observe = await import("./observe");
    expect(observe.crashReportingAvailable).toBe(true);
    expect(h.loadNativeSdk).toHaveBeenCalledOnce();
    await h.preferencesRequested;
    expect(h.sdk.configure).not.toHaveBeenCalled();
    h.preferences.resolve({ crashReportsEnabled });
    await h.configured;
    expect(h.sdk.dispatchEvents).toHaveBeenCalledTimes(crashReportsEnabled === false ? 0 : 1);
    expect(h.sdk.configure).toHaveBeenCalledExactlyOnceWith({
      dispatchingEnabled: crashReportsEnabled !== false,
      environment: "production",
    });
    const error = new Error("unhandled rejection");
    h.rejectionTracker.mock.calls[0]![0].onUnhandled(1, error);
    expect(h.sdk.reportError).toHaveBeenCalledWith(error);
  },
);

it("keeps a newer explicit disable when preference loading and an older enable finish", async () => {
  const h = setup(configuredExtra);
  const observe = await import("./observe");
  await h.preferencesRequested;
  const dispatch = Promise.withResolvers<void>();
  h.sdk.dispatchEvents.mockReturnValueOnce(dispatch.promise);
  const enabling = observe.setCrashReportsEnabled(true);
  await observe.setCrashReportsEnabled(false);
  h.preferences.resolve({ crashReportsEnabled: true });
  dispatch.resolve();
  await enabling;
  await vi.dynamicImportSettled();
  expect(h.sdk.configure).toHaveBeenCalledExactlyOnceWith({
    dispatchingEnabled: false,
    environment: "production",
  });
});

it("contains an optional SDK load failure at startup and in the render boundary", async () => {
  const h = setup(configuredExtra, new Error("native SDK unavailable"));
  const observe = await import("./observe");
  expect(observe.crashReportingAvailable).toBe(false);
  await expect(observe.setCrashReportsEnabled(true)).resolves.toBeUndefined();
  const { RenderErrorBoundary } = await import("../../components/RenderErrorBoundary");
  const boundary = new RenderErrorBoundary({ children: null });
  const update = vi.spyOn(boundary, "setState").mockImplementation(() => {});
  boundary.componentDidCatch(new Error("render failed"), { componentStack: "at Screen" });
  expect(update).toHaveBeenCalledWith({ componentStack: "at Screen" });
  expect(h.loadNativeSdk).toHaveBeenCalledOnce();
  expect(h.rejectionTracker).not.toHaveBeenCalled();
  expect(h.warnings).toHaveBeenCalled();
});

it("keeps render-error recovery and rejection tracking safe when reporting throws", async () => {
  const h = setup(configuredExtra);
  const { RenderErrorBoundary } = await import("../../components/RenderErrorBoundary");
  await h.preferencesRequested;
  h.preferences.resolve({ crashReportsEnabled: false });
  await h.configured;
  h.sdk.reportError.mockImplementation(() => {
    throw new Error("native report failed");
  });
  const boundary = new RenderErrorBoundary({ children: null });
  const update = vi.spyOn(boundary, "setState").mockImplementation(() => {});
  const error = new Error("render failed");
  expect(() => boundary.componentDidCatch(error, { componentStack: "at Screen" })).not.toThrow();
  expect(update).toHaveBeenCalledWith({ componentStack: "at Screen" });
  expect(() => h.rejectionTracker.mock.calls[0]![0].onUnhandled(1, error)).not.toThrow();
});

it.each(["dispatch", "configure"])("contains optional %s failures", async (failure) => {
  const h = setup(configuredExtra);
  const observe = await import("./observe");
  await h.preferencesRequested;
  h.preferences.resolve({ crashReportsEnabled: false });
  await h.configured;
  h.sdk.configure.mockClear();
  if (failure === "dispatch") {
    h.sdk.dispatchEvents.mockRejectedValueOnce(new Error("dispatch failed"));
  } else {
    h.sdk.configure.mockImplementationOnce(() => {
      throw new Error("configure failed");
    });
  }
  await expect(observe.setCrashReportsEnabled(true)).resolves.toBeUndefined();
  await observe.setCrashReportsEnabled(false);
  expect(h.sdk.configure).toHaveBeenLastCalledWith({
    dispatchingEnabled: false,
    environment: "production",
  });
  expect(h.warnings).toHaveBeenCalled();
});

it("retains the native choice when preferences cannot be read", async () => {
  const h = setup(configuredExtra);
  await import("./observe");
  await h.preferencesRequested;
  h.preferences.reject(new Error("storage unavailable"));
  await vi.dynamicImportSettled();
  expect(h.sdk.configure).not.toHaveBeenCalled();
  expect(h.warnings).toHaveBeenCalled();
});
