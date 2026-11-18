import Constants from "expo-constants";

const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

function loadObserve() {
  if (
    typeof relayUrl !== "string" ||
    relayUrl.trim() === "" ||
    typeof projectId !== "string" ||
    projectId.trim() === ""
  ) {
    return null;
  }
  try {
    // Native OnCreate requires a project ID before configure; keep configured error capture early.
    return (require("expo-observe") as typeof import("expo-observe")).Observe;
  } catch (error) {
    console.warn("[observe] could not load crash reporting", error);
    return null;
  }
}

const Observe = loadObserve();
export const crashReportingAvailable = Observe !== null;

export function reportCrash(error: unknown) {
  try {
    Observe?.reportError(error);
  } catch (reportingError) {
    console.warn("[observe] could not report error", reportingError);
  }
}

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
if (Observe && !__DEV__) {
  try {
    const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, rejection) => reportCrash(rejection),
    });
  } catch (error) {
    console.warn("[observe] could not track promise rejections", error);
  }
}

let latestConfiguration = 0;

// While sending is off, a dispatch pass drops what it finds, so one runs before turning it back on.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  if (!Observe) return;
  try {
    if (enabled) {
      await Observe.dispatchEvents();
      if (configuration !== latestConfiguration) return;
    }
    Observe.configure({
      dispatchingEnabled: enabled,
      ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
    });
  } catch (error) {
    console.warn("[observe] could not apply the crash report setting", error);
  }
}

if (Observe) {
  // Observe keeps its last configuration across launches; configuring it off while the setting
  // loads would drop the last session's native crash. Imported lazily so the persistence graph
  // never runs ahead of the imports `index.ts` orders first.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled !== false),
      // Observe keeps the last choice it was given, which stands in for the unreadable one.
      (error: unknown) => console.warn("[observe] could not read the crash report setting", error),
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
