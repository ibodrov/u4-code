import { assert, it } from "@effect/vitest";
import {
  MACOS_MANAGED_PREFERENCES_PATH,
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { macosProfile, windowsAdmx } from "./policyTemplates.ts";

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="SOFTWARE\\Policies\\T3Tools\\T3Code\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

it("installs the macOS profile for U4's preference domain, apart from T3 Code's", () => {
  const profile = macosProfile(
    { schemaVersion: 1, organization: "Example Corp" },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.equal(profile._tag, "Valid");
  if (profile._tag !== "Valid") return;
  assert.equal(
    MACOS_MANAGED_PREFERENCES_PATH,
    "/Library/Managed Preferences/ca.ibodrov.u4code.plist",
  );
  const value = (key: string) =>
    [
      ...profile.profile.matchAll(
        new RegExp(`<key>${key}</key>\\n\\s*<string>([^<]*)</string>`, "g"),
      ),
    ].map((match) => match[1]);
  assert.deepStrictEqual(value("PayloadType"), ["ca.ibodrov.u4code", "Configuration"]);
  // A shared identifier would replace official T3 Code's installed profile.
  assert.deepStrictEqual(value("PayloadIdentifier"), [
    "ca.ibodrov.u4code.policy.payload-uuid",
    "ca.ibodrov.u4code.policy",
  ]);
});
