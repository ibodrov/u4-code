import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
export function prepareVolume(root, generation) {
  if (!/^[1-9][0-9]*$/.test(generation ?? "")) throw new Error("invalid generation");
  for (const name of ["workspace", "cache", "build", "state", "provider"]) {
    const path = `${root}/${name}`;
    NodeFS.mkdirSync(path, { recursive: true });
    const stat = NodeFS.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid volume layout");
  }
  NodeFS.chmodSync(`${root}/provider`, 0o700);
  NodeFS.chmodSync(`${root}/state`, 0o700);
  // The migration marker is server-only; build code cannot force a later recursive chmod.
  const marker = `${root}/state/build-permissions-v2`;
  if (!NodeFS.existsSync(marker)) {
    const migrate = (path) => {
      const stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink()) return;
      NodeFS.chmodSync(path, stat.isDirectory() ? 0o2770 : 0o660 | (stat.mode & 0o111 ? 0o110 : 0));
      if (stat.isDirectory())
        for (const name of NodeFS.readdirSync(path)) migrate(`${path}/${name}`);
    };
    migrate(`${root}/cache`);
    NodeFS.writeFileSync(marker, "2", { mode: 0o600 });
  }
  NodeFS.chmodSync(`${root}/build`, 0o2770);
  NodeFS.mkdirSync(`${root}/cache/home`, { recursive: true, mode: 0o2770 });
  NodeFS.writeFileSync(`${root}/state/generation`, generation, { mode: 0o600 });
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href)
  prepareVolume("/data", process.argv[2]);
