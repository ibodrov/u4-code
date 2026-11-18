import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

const manifests = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const hash = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const save = (file, value) => NodeFS.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")}: ${result.error ?? result.stderr ?? result.status}`,
    );
  return result.stdout;
}

export function validateArchiveEntries(entries, root) {
  NodeAssert.ok(entries.length > 0, "empty archive");
  for (const entry of entries) {
    const parts = entry.split("/");
    NodeAssert.ok(
      parts[0] === root && !parts.includes("..") && !entry.startsWith("/") && !entry.includes("\\"),
      "unsafe archive entry: " + entry,
    );
  }
}

export function validateVersionChanges(before, after, version) {
  NodeAssert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const name of Object.keys(before)) {
    NodeAssert.equal(after[name].version, version, name);
    NodeAssert.deepEqual({ ...after[name], version: before[name].version }, before[name], name);
  }
}

export function validatePreflight(stdout, version, protocol, blocked) {
  const result = JSON.parse(stdout.trim());
  NodeAssert.equal(result.version, version);
  NodeAssert.equal(result.status, blocked ? "blocked" : "ready");
  if (blocked) NodeAssert.ok(typeof result.reason === "string" && result.reason.length > 0);
  else NodeAssert.equal(result.launcherProtocol, protocol);
  return result;
}

export function assertPreflightUnchanged(database, beforeFiles, beforeHash) {
  NodeAssert.equal(hash(database), beforeHash, "preflight changed database bytes");
  const sidecars = new Set([
    NodePath.basename(database) + "-shm",
    NodePath.basename(database) + "-wal",
  ]);
  const stable = (files) => files.filter((file) => !sidecars.has(file)).sort();
  NodeAssert.deepEqual(stable(NodeFS.readdirSync(NodePath.dirname(database))), stable(beforeFiles));
  const wal = database + "-wal";
  NodeAssert.ok(
    !NodeFS.existsSync(wal) || NodeFS.statSync(wal).size === 0,
    "preflight left nonempty WAL",
  );
}

export async function snapshotDatabase(source, destination) {
  const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  try {
    await NodeSqlite.backup(db, destination);
  } finally {
    db.close();
  }
}

function checkSource(root) {
  NodeAssert.equal(
    run("git", ["status", "--porcelain"], { cwd: root }).trim(),
    "",
    "source overlays",
  );
  for (const file of run("git", ["ls-files", "-z"], { cwd: root }).split("\0").filter(Boolean)) {
    const base = NodePath.basename(file);
    NodeAssert.ok(
      !(/^\.env(?:\.|$)/.test(base) && !base.endsWith(".example")),
      "effective dotenv file: " + file,
    );
  }
  for (const file of [".env", ".env.local"])
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(root, file)), file);
}

function checkVersions(root, version) {
  const before = {},
    after = {};
  for (const name of manifests) {
    before[name] = JSON.parse(run("git", ["show", `HEAD:${name}`], { cwd: root }));
    after[name] = json(NodePath.join(root, name));
  }
  validateVersionChanges(before, after, version);
  const changed = run("git", ["diff", "--name-only"], { cwd: root })
    .trim()
    .split("\n")
    .filter(Boolean);
  NodeAssert.ok(
    changed.every((file) => manifests.includes(file)),
    "unexpected tracked build mutation: " + changed,
  );
  for (const file of [".env", ".env.local"])
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(root, file)), file);
}

function filesBelow(root) {
  return NodeFS.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = NodePath.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

function isolated(root) {
  for (const part of ["home", "tmp", "run", "config", "data", "cache", "state"])
    NodeFS.mkdirSync(NodePath.join(root, part), { recursive: true, mode: 0o700 });
  return {
    HOME: NodePath.join(root, "home"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    TMPDIR: NodePath.join(root, "tmp"),
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
    XDG_DATA_HOME: NodePath.join(root, "data"),
    XDG_CACHE_HOME: NodePath.join(root, "cache"),
    XDG_STATE_HOME: NodePath.join(root, "state"),
    XDG_RUNTIME_DIR: NodePath.join(root, "run"),
    PATH: "/opt/node/bin:/opt/rust/bin:/usr/bin:/bin",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
  };
}
function assertOwnership(root) {
  const names = NodeFS.readdirSync(root, { recursive: true }).map(String);
  NodeAssert.ok(
    !names.some((file) =>
      file
        .split("/")
        .some((part) => part === ".t3" || part === "t3code" || part === "com.t3tools.t3code"),
    ),
    "official T3 state/control path",
  );
  return names;
}
export function selectGlibcNativeFiles(files) {
  const alternatives = [];
  const selected = files.filter((file) => {
    let counterpart;
    if (file.endsWith("/@yuuang/ffi-rs-linux-x64-musl/ffi-rs.linux-x64-musl.node"))
      counterpart = file.replace(
        "/ffi-rs-linux-x64-musl/ffi-rs.linux-x64-musl.node",
        "/ffi-rs-linux-x64-gnu/ffi-rs.linux-x64-gnu.node",
      );
    else if (file.endsWith("/@koromix/koffi-linux-x64/musl_x64/koffi.node"))
      counterpart = file.replace("/musl_x64/koffi.node", "/linux_x64/koffi.node");
    if (counterpart === undefined) return true;
    NodeAssert.ok(files.includes(counterpart), "missing GNU counterpart for " + file);
    alternatives.push({
      file,
      counterpart,
      reason: "musl fallback; Debian uses the checked GNU backend",
    });
    return false;
  });
  return { selected, alternatives };
}

function nativeEvidence(file) {
  const kind = run("file", [file]);
  NodeAssert.ok(kind.includes("ELF 64-bit") && kind.includes("x86-64"), kind);
  const dependencies = run("ldd", [file]);
  NodeAssert.ok(!dependencies.includes("not found"), dependencies);
  return { file, kind, dependencies, symbolVersions: run("readelf", ["--version-info", file]) };
}
function scanText(text, file) {
  const forbidden = [
    "ingest.t3.codes",
    "u.expo.dev",
    "registry.npmjs.org/t3/",
    "pingdotgg/t3code/releases",
    "t3.codes/install.sh",
    "relay.t3.codes",
  ];
  for (const value of forbidden)
    NodeAssert.ok(!text.includes(value), `official executable configuration ${value} in ${file}`);
  NodeAssert.ok(!/pk_(?:live|test)_[A-Za-z0-9]{12,}/.test(text), "embedded Clerk key in " + file);
}
function scanExecutableText(root) {
  for (const file of filesBelow(root).filter((name) => /\.(?:c?js|mjs|html|json|yml)$/.test(name)))
    scanText(NodeFS.readFileSync(file, "utf8"), file);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = NodeEvents.once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 10_000);
  timer.unref();
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function serve(executable, env, evidenceDir) {
  const reservation = NodeNet.createServer();
  reservation.listen(0, "127.0.0.1");
  await NodeEvents.once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const log = NodeFS.openSync(
    NodePath.join(
      evidenceDir,
      NodePath.basename(env.HOME) +
        "-" +
        NodePath.basename(NodePath.dirname(env.HOME)) +
        "-server.log",
    ),
    "w",
  );
  const child = NodeChildProcess.spawn(
    executable,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
    NodeFS.writeSync(log, data);
  });
  child.stderr.on("data", (data) => {
    output += data;
    NodeFS.writeSync(log, data);
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  try {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (spawnError) throw spawnError;
      NodeAssert.ok(
        child.exitCode === null && child.signalCode === null,
        "server exited: " + output,
      );
      {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok)
            return {
              child,
              descriptor: await response.json(),
              close: async () => {
                try {
                  await stop(child);
                } finally {
                  NodeFS.closeSync(log);
                }
              },
            };
        } catch {}
      }
      await NodeTimersPromises.setTimeout(250);
    }
    throw new Error("server did not report a ready descriptor: " + output);
  } catch (error) {
    try {
      await stop(child);
    } finally {
      NodeFS.closeSync(log);
    }
    throw error;
  }
}
function fixtureText(database) {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const result = [];
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()) {
        for (const value of Object.values(row))
          if (
            typeof value === "string" &&
            (value.includes("Release launch check") ||
              value.includes("The release opens and shows this thread."))
          )
            result.push(value);
      }
    }
    return result.sort();
  } finally {
    db.close();
  }
}
async function artifactChecks(source, out, version, sourceSha) {
  const evidence = NodePath.join(out, "evidence");
  const report = {
    sourceSha,
    sourceTree: process.env.U4_SOURCE_TREE,
    bundleSha256: process.env.U4_BUNDLE_SHA256,
    version,
    checks: [],
    limitations: [
      "Only the tested Debian 12 amd64 baseline is covered",
      "No ordinary serve future-state refusal or arbitrary same-protocol compatibility claim",
      "Final interactive AppImage and signed APK acceptance belongs to Root",
    ],
  };
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      report.checks.push({ name, status: "passed", detail });
      save(NodePath.join(evidence, "linux-runtime.json"), report);
      return detail;
    } catch (error) {
      report.checks.push({ name, status: "failed", error: String(error) });
      save(NodePath.join(evidence, "linux-runtime.json"), report);
      throw error;
    }
  };
  NodeFS.mkdirSync("/work/checks", { recursive: true });
  const require = NodeModule.createRequire(NodePath.join(source, "scripts/package.json"));
  const asar = require("@electron/asar");
  const appImage = NodePath.join(out, "unsigned", `U4-Code-${version}-x86_64.AppImage`);
  const archive = NodePath.join(out, "unsigned", `t3-${version}-linux-x64.tar.gz`);
  const extracted = "/work/checks/appimage";
  NodeFS.mkdirSync(extracted);
  await record("AppImage extraction", () => {
    run(appImage, ["--appimage-extract"], {
      cwd: extracted,
      env: isolated("/work/checks/extract-env"),
    });
    const kind = run("file", [appImage]);
    NodeAssert.ok(kind.includes("ELF 64-bit") && kind.includes("x86-64"), kind);
    return { sha256: hash(appImage), kind };
  });
  const app = NodePath.join(extracted, "squashfs-root");
  const appFiles = "/work/checks/asar";
  asar.extractAll(NodePath.join(app, "resources/app.asar"), appFiles);
  await record("packaged identity and upstream endpoint scan", () => {
    const desktopFiles = NodeFS.readdirSync(app).filter((name) => name.endsWith(".desktop"));
    NodeAssert.equal(desktopFiles.length, 1);
    const desktop = NodeFS.readFileSync(NodePath.join(app, desktopFiles[0]), "utf8");
    for (const line of [
      "Name=U4 Code",
      "Icon=u4code",
      "StartupWMClass=ca.ibodrov.U4Code",
      "x-scheme-handler/u4code;",
      "x-scheme-handler/u4code-dev;",
    ])
      NodeAssert.ok(desktop.includes(line), line);
    NodeAssert.ok(!/t3code|com\.t3tools/.test(desktop));
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(app, "t3code")));
    NodeAssert.ok(!NodeFS.existsSync(NodePath.join(app, "resources/app-update.yml")));
    const pkg = json(NodePath.join(appFiles, "package.json"));
    NodeAssert.equal(pkg.version, version);
    NodeAssert.equal(pkg.t3codeCommitHash, sourceSha.slice(0, 12));
    scanExecutableText(appFiles);
    const licenses = [...filesBelow(app), ...filesBelow(appFiles)].filter((name) =>
      /license|notice/i.test(NodePath.basename(name)),
    );
    NodeAssert.ok(
      licenses.some((file) => NodeFS.readFileSync(file, "utf8").includes("T3 Tools Inc.")),
      "upstream MIT notice missing",
    );
    return { desktop, package: pkg, licenses };
  });
  const cliRoot = `t3-${version}-linux-x64`;
  const cliExtract = "/work/checks/cli";
  NodeFS.mkdirSync(cliExtract);
  await record("CLI archive layout", () => {
    const entries = run("tar", ["-tzf", archive]).trim().split("\n");
    validateArchiveEntries(entries, cliRoot);
    // Reject links altogether before extracting a release archive into the runtime fixture.
    const listing = run("tar", ["-tvzf", archive]);
    NodeAssert.ok(
      listing
        .split("\n")
        .filter(Boolean)
        .every((line) => line[0] === "-" || line[0] === "d"),
      "archive contains links or special files",
    );
    run("tar", ["-xzf", archive, "-C", cliExtract]);
    return { sha256: hash(archive), entries };
  });
  const cli = NodePath.join(cliExtract, cliRoot),
    executable = NodePath.join(cli, "t3");
  await record("native ELF loading, libatomic source and client assets", () => {
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(cli, "client/index.html")));
    const monitor = filesBelow(NodePath.join(cli, "resource-monitor")).filter(
      (file) => NodePath.basename(file) === "t3-resource-monitor",
    );
    NodeAssert.equal(monitor.length, 1);
    const nativeFiles = [
      executable,
      NodePath.join(cli, "lib/libatomic.so.1"),
      monitor[0],
      NodePath.join(app, "u4code"),
      ...filesBelow(cli).filter((file) => file.endsWith(".node")),
      ...filesBelow(app).filter((file) => file.endsWith(".node")),
    ];
    const selection = selectGlibcNativeFiles(nativeFiles);
    const native = selection.selected.map(nativeEvidence);
    const nativeLoader = JSON.parse(
      run(
        process.execPath,
        [
          "-e",
          "require('ffi-rs'); require('koffi'); console.log(JSON.stringify(Object.keys(require.cache).filter(file => file.endsWith('.node'))))",
        ],
        { cwd: cli, env: isolated("/work/checks/native-loader") },
      ),
    );
    for (const alternative of selection.alternatives.filter((entry) =>
      entry.file.startsWith(cli + "/"),
    ))
      NodeAssert.ok(
        nativeLoader.some(
          (file) => NodeFS.realpathSync(file) === NodeFS.realpathSync(alternative.counterpart),
        ),
        "native loader did not select GNU counterpart: " + alternative.counterpart,
      );
    NodeAssert.ok(
      !nativeLoader.some((file) => /musl/.test(file)),
      "native loader selected a musl backend",
    );
    const hello = JSON.parse(
      run(monitor[0], [], {
        input: '{"type":"shutdown","version":3}\n',
        env: isolated("/work/checks/monitor"),
      })
        .trim()
        .split("\n")[0],
    );
    NodeAssert.equal(hello.type, "hello");
    NodeAssert.equal(hello.version, 3);
    NodeAssert.equal(hello.platform, "linux");
    NodeAssert.equal(hello.arch, "x86_64");
    const loaded = /libatomic\.so\.1 => (\/\S+)/.exec(native[0].dependencies)?.[1];
    NodeAssert.ok(
      loaded &&
        NodeFS.realpathSync(loaded) ===
          NodeFS.realpathSync(NodePath.join(cli, "lib/libatomic.so.1")),
      "CLI did not load bundled libatomic",
    );
    const license = NodeFS.readFileSync(NodePath.join(cli, "lib/libatomic.so.1.LICENSE"), "utf8");
    const actual = run("dpkg-query", [
      "-W",
      "-f=${Version}\t${source:Package}\t${source:Version}",
      "libatomic1",
    ])
      .trim()
      .split("\t");
    NodeAssert.ok(license.includes("Debian package libatomic1:amd64 " + actual[0]));
    NodeAssert.ok(
      license.includes(
        `https://sources.debian.org/src/${actual[1]}/${encodeURIComponent(actual[2])}/`,
      ),
    );
    NodeAssert.ok(license.includes("GCC-exception-3.1") && !license.includes("Ubuntu package"));
    scanExecutableText(cli);
    scanText(NodeFS.readFileSync(executable, "utf8"), executable);
    return {
      native,
      nativeLoader,
      alternatives: selection.alternatives,
      monitorHello: hello,
      libatomicLicense: license,
    };
  });
  await record("CLI version and embedded preflight", () => {
    const env = isolated("/work/checks/cli-version");
    env.PATH = "";
    const actual = run(executable, ["--version"], { env });
    NodeAssert.ok(actual.includes(version));
    return { version: actual };
  });
  let descriptor;
  await record("CLI default home, descriptor and control ownership", async () => {
    const root = "/work/checks/cli-default",
      env = isolated(root);
    const server = await serve(executable, env, evidence);
    try {
      descriptor = server.descriptor;
      NodeAssert.equal(descriptor.serverVersion, version);
      NodeAssert.equal(descriptor.orchestrationProtocolVersion, 2);
      NodeAssert.ok(Number.isInteger(descriptor.databaseMigration));
    } finally {
      await server.close();
    }
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(env.HOME, ".u4/userdata")));
    return { descriptor, paths: assertOwnership(root) };
  });
  await record("older seeded migration retains thread content", async () => {
    const root = "/work/checks/older",
      env = isolated(root),
      home = NodePath.join(root, "u4");
    env.U4CODE_HOME = home;
    const dbPath = NodePath.join(home, "userdata/statev2.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
    NodeFS.copyFileSync(
      NodePath.join(source, "scripts/fixtures/desktop-launch/statev2.sqlite"),
      dbPath,
    );
    const before = fixtureText(dbPath);
    NodeAssert.ok(before.length >= 2, "fixture content absent");
    const server = await serve(executable, env, evidence);
    try {
      NodeAssert.equal(server.descriptor.databaseMigration, descriptor.databaseMigration);
    } finally {
      await server.close();
    }
    const after = fixtureText(dbPath);
    NodeAssert.deepEqual(after, before);
    const migrated = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    let ledger;
    try {
      ledger = migrated
        .prepare("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id")
        .all();
      NodeAssert.equal(
        Math.max(...ledger.map((row) => Number(row.migration_id))),
        descriptor.databaseMigration,
      );
    } finally {
      migrated.close();
    }
    await snapshotDatabase(dbPath, NodePath.join(evidence, "older-migrated.sqlite"));
    return { before, after, ledger, paths: assertOwnership(root) };
  });
  await record(
    "packaged preflight: launcher 3/4, unsupported and future-ledger byte preservation",
    async () => {
      const root = "/work/checks/preflight",
        env = isolated(root),
        database = NodePath.join(root, "statev2.sqlite");
      NodeFS.copyFileSync(NodePath.join(evidence, "older-migrated.sqlite"), database);
      const invoke = (protocol) =>
        run(
          executable,
          [
            "__service-preflight",
            "--database-path",
            database,
            "--launcher-protocol",
            String(protocol),
          ],
          { env },
        );
      const beforeFiles = NodeFS.readdirSync(root).sort();
      const before = hash(database),
        results = [];
      for (const protocol of [3, 4, 999]) {
        results.push(validatePreflight(invoke(protocol), version, protocol, protocol === 999));
        assertPreflightUnchanged(database, beforeFiles, before);
      }
      const db = new NodeSqlite.DatabaseSync(database);
      db.prepare("INSERT INTO effect_sql_migrations (migration_id,name) VALUES (?,?)").run(
        descriptor.databaseMigration + 1,
        "U4FutureFixture",
      );
      db.close();
      const futureHash = hash(database),
        future = validatePreflight(invoke(4), version, 4, true);
      NodeAssert.ok(future.reason.includes("U4FutureFixture"));
      assertPreflightUnchanged(database, beforeFiles, futureHash);
      await snapshotDatabase(database, NodePath.join(evidence, "future-preserved.sqlite"));
      return { results, future, before, futureHash, afterFuture: hash(database) };
    },
  );
  await record("desktop isolated Xvfb launch, default profile and seeded content", async () => {
    const root = "/work/checks/desktop",
      env = isolated(root);
    // D-Bus and Xvfb are owned by the subprocess wrapper, without host display or session sockets.
    const helper = NodePath.join("/in/tools", "linux-runtime-checks.mjs");
    run(
      "dbus-run-session",
      ["--", "xvfb-run", "-a", process.execPath, helper, "desktop", source, app, evidence, root],
      { env, timeout: 180_000 },
    );
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(env.HOME, ".u4/userdata")));
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(env.XDG_CONFIG_HOME, "u4code")),
      "U4 Electron profile missing",
    );
    return { paths: assertOwnership(root) };
  });
  await record("stock CLI archive smoke", () => ({
    output: run(
      process.execPath,
      [
        NodePath.join(source, "scripts/smoke-cli-archive.ts"),
        "--archive",
        archive,
        "--expect-version",
        version,
      ],
      { cwd: source, env: isolated("/work/checks/stock-cli"), timeout: 120_000 },
    ),
  }));
}

async function desktopCheck(source, app, evidence, root) {
  const require = NodeModule.createRequire(NodePath.join(source, "scripts/package.json"));
  const { _electron } = require("playwright-core");
  const env = isolated(root);
  for (const name of ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"])
    if (process.env[name]) env[name] = process.env[name];
  const home = NodePath.join(env.HOME, ".u4"),
    db = NodePath.join(home, "userdata/statev2.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(db), { recursive: true });
  NodeFS.copyFileSync(NodePath.join(source, "scripts/fixtures/desktop-launch/statev2.sqlite"), db);
  let electron;
  try {
    electron = await _electron.launch({
      executablePath: NodePath.join(app, "u4code"),
      args: ["--no-sandbox"],
      env,
      timeout: 60_000,
    });
    const page = await electron.firstWindow({ timeout: 60_000 });
    const thread = page.locator("li[data-thread-item]", { hasText: "Release launch check" });
    await thread.waitFor({ timeout: 60_000 });
    await thread.click();
    await page.getByText("The release opens and shows this thread.").waitFor({ timeout: 60_000 });
    await page.screenshot({ path: NodePath.join(evidence, "desktop-window.png") });
  } finally {
    if (electron) {
      const child = electron.process();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timeout.unref();
      try {
        await electron.close();
      } finally {
        clearTimeout(timeout);
      }
    }
    if (NodeFS.existsSync(home))
      NodeFS.cpSync(home, NodePath.join(evidence, "desktop-fixture"), { recursive: true });
    save(NodePath.join(evidence, "desktop-paths.json"), assertOwnership(root));
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "source") checkSource(args[0]);
  else if (command === "versions") checkVersions(args[0], args[1]);
  else if (command === "artifacts") await artifactChecks(...args);
  else if (command === "desktop") await desktopCheck(...args);
  else throw new Error("Expected source, versions, artifacts or desktop");
}
