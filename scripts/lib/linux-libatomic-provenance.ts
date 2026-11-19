export function libatomicProvenance(osRelease: string, owner: string, versions: string): string {
  const distro = /^ID=["']?([a-z]+)["']?$/m.exec(osRelease)?.[1];
  if (distro !== "debian" && distro !== "ubuntu") {
    throw new Error(`Unsupported libatomic provenance distribution: ${distro ?? "unknown"}`);
  }
  const qualifiedPackage = /^((libatomic1)(?::[a-z0-9-]+)?): \/[^\n]+\n?$/.exec(owner)?.[1];
  const fields = versions.trim().split("\t");
  if (
    !qualifiedPackage ||
    fields.length !== 3 ||
    fields.some((field) => !/^[a-zA-Z0-9.+:~-]+$/.test(field))
  ) {
    throw new Error("Cannot identify the single dpkg libatomic1 owner and source package/version");
  }
  const [version, sourcePackage, sourceVersion] = fields;
  const source =
    distro === "debian"
      ? `https://sources.debian.org/src/${sourcePackage}/${encodeURIComponent(sourceVersion!)}/`
      : `https://launchpad.net/ubuntu/+source/${sourcePackage}/${encodeURIComponent(sourceVersion!)}`;
  return [
    `libatomic.so.1 is copied from the ${distro === "debian" ? "Debian" : "Ubuntu"} package ${qualifiedPackage} ${version}.`,
    `Source package: ${sourcePackage} ${sourceVersion}`,
    `Source: ${source}`,
    "License: GPL-3.0-or-later WITH GCC-exception-3.1",
  ].join("\n");
}
