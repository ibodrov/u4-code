import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  resolveU4ReleaseBaseUrl,
  cliReleaseAssetUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("requires an explicit U4 source and maps its version without an upstream tag prefix", () => {
    expect(cliReleaseDownloadBaseUrl("0.1.10-u4.8")).toBeUndefined();
    expect(cliReleaseAssetUrl("0.1.10-u4.8", "SHA256SUMS", " ")).toBeUndefined();
    expect(
      cliReleaseAssetUrl(
        "0.1.10-u4.8",
        "SHA256SUMS",
        "https://updates.example/releases/?token=abc",
      ),
    ).toBe("https://updates.example/releases/0.1.10-u4.8/SHA256SUMS?token=abc");
    expect(
      cliReleaseAssetUrl("0.1.10", "SHA256SUMS", "https://updates.example/releases"),
    ).toBeUndefined();
    expect(
      cliReleaseAssetUrl(
        "0.1.10-u4.8",
        "SHA256SUMS",
        "https://github.com/pingdotgg/t3code/releases/download",
      ),
    ).toBeUndefined();
  });
  it("resolves policy-only and environment-only sources without falling back from invalid policy", () => {
    expect(resolveU4ReleaseBaseUrl("https://policy.example/releases")).toBe(
      "https://policy.example/releases",
    );
    expect(resolveU4ReleaseBaseUrl(undefined, "https://env.example/releases")).toBe(
      "https://env.example/releases",
    );
    expect(
      resolveU4ReleaseBaseUrl("https://policy.example/releases", "https://env.example/releases"),
    ).toBe("https://policy.example/releases");
    for (const policy of [
      "",
      "invalid",
      "https://t3.codes/install.sh",
      "https://api.github.com/repos/pingdotgg/t3code/releases",
    ]) {
      expect(resolveU4ReleaseBaseUrl(policy, "https://env.example/releases")).toBeUndefined();
    }
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks only non-draft U4 releases on the requested channel", () => {
    const releases = [
      { tag_name: "v0.1.10-u4.9", draft: true },
      { tag_name: "v99.0.0" },
      { tag_name: "desktop-preview" },
      { tag_name: "v0.1.10-u4.8" },
      { tag_name: "v0.1.10-u4.7" },
    ];
    expect(newestCliReleaseVersion(releases, "stable")).toBe("0.1.10-u4.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBeUndefined();
    expect(newestCliReleaseVersion(releases, "preview")).toBeUndefined();
  });
});
