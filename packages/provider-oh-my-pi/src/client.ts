import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("oh-my-pi"),
  label: "oh-my-pi",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 120 90",
    fill: { light: "#0d0d0d", dark: "#fafafa" },
    // Derived from can1357/oh-my-pi assets/icon.svg (MIT).
    paths: [
      {
        d: "M12 8h96a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM25 20h12v60a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2ZM75 20h12v45H75Z",
      },
      {
        d: "M74 55h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H74a3 3 0 0 1-3-3V58a3 3 0 0 1 3-3Z",
        fill: { light: "#f97316", dark: "#f97316" },
      },
      { d: "M76 59h3v8h-3ZM82 59h3v8h-3Z", fill: { light: "#0d0d0d", dark: "#0d0d0d" } },
    ],
  },
});
