import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canMaintainEnvironment, findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  it("checks U4 releases and ignores official versions in the release index", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tag_name: "v99.0.0" }))
      .mockResolvedValueOnce(Response.json([{ tag_name: "v0.1.10-u4.9" }]))
      .mockResolvedValueOnce(Response.json({ tag_name: "v0.1.10-u4.9" }));
    vi.stubGlobal("fetch", fetch);
    expect(await findEnvironmentUpdate("0.1.10-u4.8", signal)).toBe("0.1.10-u4.9");
    expect(await findEnvironmentUpdate("0.1.10-u4.9", signal)).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/ibodrov/u4-code/releases/latest",
      "https://api.github.com/repos/ibodrov/u4-code/releases?per_page=100&page=1",
      "https://github.com/ibodrov/u4-code/releases/latest",
    ]);
  });

  it("reports unavailable or invalid U4 releases and refuses non-U4 hosts before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("Only exact U4");
    expect(fetch).not.toHaveBeenCalled();
    for (const status of [401, 403, 429]) {
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await expect(findEnvironmentUpdate("0.1.10-u4.8", signal)).rejects.toThrow(String(status));
    }
    fetch.mockResolvedValueOnce(Response.json({ error: "invalid" }));
    await expect(findEnvironmentUpdate("0.1.10-u4.8", signal)).rejects.toThrow();
    fetch
      .mockResolvedValueOnce(Response.json({ tag_name: "v1.0.0" }))
      .mockResolvedValueOnce(Response.json([]));
    await expect(findEnvironmentUpdate("0.1.10-u4.8", signal)).rejects.toThrow("No stable release");
  });
});
