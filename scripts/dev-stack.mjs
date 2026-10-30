#!/usr/bin/env node
// npm run dev:stack [-- up|down|reset|rebuild|status]
//
// Runs the whole SpaceApp from source for contributors (ONB-001, #65): PostgreSQL (pgvector) and Temporal in Docker with
// the images pinned in packages/run-spaceapp/templates/compose.yml, the migrations, then the API (tsx watch), the Vite
// web dev server, the Temporal worker (tsc --watch + node --watch) and the CLI host, all from this checkout. It is
// isolated from an installed SpaceApp: its own compose project, its own git-ignored state directory and its own ports,
// all bound to 127.0.0.1. Secrets live in the state directory with mode 0600 and only the setup token is printed.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, unwatchFile, watchFile } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PROJECT = "spaceapp-dev-stack";
export const STATE_MARKER = ".spaceapp-dev-stack";
export const INSTALL_PORTS = Object.freeze([4910, 4911]);
export const DEFAULT_PORTS = Object.freeze({ api: 4920, web: 4921, postgres: 4922, temporal: 4923 });
const PORT_ENV = Object.freeze({
  api: "SPACE_DEV_STACK_API_PORT",
  web: "SPACE_DEV_STACK_WEB_PORT",
  postgres: "SPACE_DEV_STACK_POSTGRES_PORT",
  temporal: "SPACE_DEV_STACK_TEMPORAL_PORT"
});
// Library packages the apps import from their dist/ (the order of the root "build" script).
export const LIBRARY_PACKAGES = Object.freeze([
  "@space/contracts", "@space/icons", "@space/streaming", "@space/opencode-control", "@space/memory-graph",
  "@space/browser-host", "@space/cli-host", "@space/codex-app-server", "@space/runtime", "@space/db", "@space/gateway"
]);
const SECRET_NAMES = Object.freeze(["postgres-password", "session-secret", "setup-token"]);
const UNIX_SOCKET_MAX_BYTES = 100;

/** The pinned postgres and temporal images, read from the launcher's compose template (never copied by hand). */
export function readPinnedImages(composeText) {
  const images = {};
  for (const service of ["postgres", "temporal"]) {
    const block = composeText.match(new RegExp(`^ {2}${service}:\\n((?: {4}.*\\n|\\s*\\n)*)`, "m"))?.[1] ?? "";
    const image = block.match(/^ {4}image:\s*(\S+)\s*$/m)?.[1];
    if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error(`packages/run-spaceapp/templates/compose.yml has no digest-pinned image for ${service}.`);
    }
    images[service] = image;
  }
  return images;
}

/** The OpenCode package and version the CLI image installs (Dockerfile), e.g. "@opencode/cli@2.0.32". */
export function readOpenCodePackage(dockerfileText) {
  const match = dockerfileText.match(/npm install --global[^\n]*?\s((?:@opencode\/cli|opencode-ai)@\d[\w.+-]*)/);
  if (!match) throw new Error("Dockerfile does not pin an OpenCode package version.");
  const spec = match[1];
  const at = spec.lastIndexOf("@");
  return { spec, name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function parsePort(name, raw) {
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`${name} must be a port number, got "${raw}".`);
  const port = Number(raw);
  if (port < 1024 || port > 65535) throw new Error(`${name} must be between 1024 and 65535.`);
  return port;
}

export function resolveConfig(env = process.env, root = repoRoot) {
  const ports = {};
  for (const [key, envName] of Object.entries(PORT_ENV)) {
    ports[key] = env[envName] ? parsePort(envName, env[envName]) : DEFAULT_PORTS[key];
    if (INSTALL_PORTS.includes(ports[key])) {
      throw new Error(`${envName}=${ports[key]} collides with an installed SpaceApp (4910/4911). Choose another port.`);
    }
  }
  if (new Set(Object.values(ports)).size !== 4) throw new Error("The dev-stack ports must all be different.");
  const project = env.SPACE_DEV_STACK_PROJECT || DEFAULT_PROJECT;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("SPACE_DEV_STACK_PROJECT must be a lowercase compose project name.");
  if (project === "spaceapp") throw new Error("SPACE_DEV_STACK_PROJECT must not be the installed SpaceApp's project name.");
  const stateDir = resolve(root, env.SPACE_DEV_STACK_DIR || ".dev-stack");
  // reset removes this directory: never the checkout, an ancestor of it, the home directory or /.
  if (stateDir === "/" || stateDir === homedir() || `${resolve(root)}/`.startsWith(`${stateDir}/`)) {
    throw new Error(`SPACE_DEV_STACK_DIR=${stateDir} must be a directory of its own, not the checkout, its parent or your home.`);
  }
  return { root, project, ports, stateDir, host: "127.0.0.1" };
}

export function statePaths(config) {
  const s = config.stateDir;
  const socketCandidate = join(s, "run", "cli-host.sock");
  // Unix socket paths are limited to about 104-108 bytes; long checkouts put the socket in a private temp directory.
  const socketDir = Buffer.byteLength(socketCandidate) > UNIX_SOCKET_MAX_BYTES
    ? join(tmpdir(), `spaceapp-dev-${createHash("sha256").update(s).digest("hex").slice(0, 12)}`)
    : join(s, "run");
  return {
    marker: join(s, STATE_MARKER),
    secrets: join(s, "secrets"),
    compose: join(s, "compose.yml"),
    pid: join(s, "dev-stack.pid"),
    rebuildStamp: join(s, "rebuild.stamp"),
    bin: join(s, "bin"),
    cliState: join(s, "cli"),
    data: join(s, "data"),
    memory: join(s, "data", "memory"),
    workspaces: join(s, "workspaces"),
    socketDir,
    socket: join(socketDir, "cli-host.sock")
  };
}

/** The compose file of the dev stack: only PostgreSQL and Temporal, every port on 127.0.0.1. */
export function renderCompose({ images, ports, host = "127.0.0.1", secretsDir, project }) {
  const label = `      com.oll4com.spaceapp.dev-stack: "${project}"`;
  return `# Generated by scripts/dev-stack.mjs. Do not edit; images come from packages/run-spaceapp/templates/compose.yml.
name: ${project}
services:
  postgres:
    image: ${images.postgres}
    labels:
${label}
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    ports:
      - "${host}:${ports.postgres}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 3s
      timeout: 5s
      retries: 40
  temporal:
    image: ${images.temporal}
    labels:
${label}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup
    ports:
      - "${host}:${ports.temporal}:7233"
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 5s
      timeout: 10s
      retries: 60
volumes:
  postgres-data:
    labels:
${label}
secrets:
  postgres-password:
    file: ${JSON.stringify(join(secretsDir, "postgres-password"))}
`;
}

/** Creates the state directory and its secrets once (mode 0600, directory 0700); later runs reuse them. */
export async function ensureState(config, { random = (bytes) => randomBytes(bytes).toString("base64url") } = {}) {
  const paths = statePaths(config);
  if (existsSync(config.stateDir) && !existsSync(paths.marker)) {
    const entries = await readdir(config.stateDir);
    if (entries.length > 0) throw new Error(`${config.stateDir} exists and was not created by dev:stack; refusing to use it.`);
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  if (!existsSync(paths.marker)) await writeFile(paths.marker, `${config.project}\n`, { mode: 0o600 });
  for (const dir of [paths.secrets, paths.bin, paths.cliState, join(paths.cliState, "providers"), join(paths.cliState, "imported-credentials"),
    join(paths.cliState, "vendor"), paths.data, join(paths.data, "artifacts"), paths.memory, paths.workspaces, paths.socketDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const secrets = {};
  for (const name of SECRET_NAMES) {
    const file = join(paths.secrets, name);
    if (!existsSync(file)) {
      // The setup token schema needs at least 32 characters; 32 random bytes give 43.
      await writeFile(file, `${random(32)}\n`, { mode: 0o600, flag: "wx" });
    }
    await chmod(file, 0o600);
    secrets[name] = (await readFile(file, "utf8")).trim();
  }
  return { paths, secrets };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The installed CLI wrapper, pointed at the state directory and this checkout instead of the container paths. */
export function renderCliWrapper(wrapperText, { cliStateRoot, deployDockerDir, memoryRoot }) {
  if (!/^set -euo pipefail$/m.test(wrapperText)) throw new Error("CLI wrapper has an unexpected header.");
  const rendered = wrapperText
    .replace(/^set -euo pipefail$/m, `set -euo pipefail\nexport SPACE_MEMORY_ROOT=${shellQuote(memoryRoot)}`)
    .replaceAll("/var/lib/spaceapp-cli", cliStateRoot)
    .replaceAll("/app/deploy/docker", deployDockerDir);
  if (/\/var\/lib\/spaceapp-cli|\/app\/deploy\//.test(rendered)) throw new Error("CLI wrapper still names a container path.");
  return rendered;
}

/** Drops SPACE_* and SPACEAPP_* variables of the caller's shell so an installed SpaceApp's settings never leak in. */
export function baseEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^SPACE(?:APP)?_/.test(key)));
}

export function serviceEnvironments(config, { paths, secrets }, env = process.env) {
  const { host, ports } = config;
  const databaseUrl = `postgres://spaceapp:${encodeURIComponent(secrets["postgres-password"])}@${host}:${ports.postgres}/spaceapp`;
  const vendorBin = join(paths.cliState, "vendor", "opencode", "node_modules", ".bin");
  const base = baseEnv(env);
  const shared = {
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_TEMPORAL_ADDRESS: `${host}:${ports.temporal}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: paths.memory,
    SPACE_STARTER_MEMORY_ROOT: join(config.root, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: join(paths.data, "memory-graph"),
    SPACE_MEMORY_INDEX_PATH: join(paths.memory, "space_memory.md"),
    SPACE_MEMORY_MONTHLY_PATH: join(paths.memory, "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: join(paths.memory, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: join(paths.data, "artifacts"),
    SPACE_CODEX_HOME: join(paths.cliState, "providers", "codex"),
    SPACE_TELEGRAM_SECRET_ROOT: join(paths.data, "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(paths.data, "integrations", "telegram", "thread-ownership.json")
  };
  const api = {
    ...base,
    ...shared,
    NODE_ENV: "development",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_DEV_LOGIN: "false",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_SESSION_SECRET: secrets["session-secret"],
    SPACE_SETUP_TOKEN_FILE: join(paths.secrets, "setup-token"),
    SPACE_API_HOST: host,
    SPACE_API_PORT: String(ports.api),
    SPACE_API_ORIGIN: `http://${host}:${ports.api}`,
    SPACE_INSTALL_ROOT: config.stateDir,
    SPACE_PROJECTS_ROOT: join(paths.data, "projects"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: join(paths.data, "demo-projects"),
    SPACE_DEMO_PROJECTS_ROOT: join(config.root, "demos"),
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: paths.socket,
    SPACE_CLI_COMMAND_PATH: paths.bin,
    SPACE_CLI_WORKSPACE_ROOT: paths.workspaces,
    SPACE_CODEX_APP_SERVER_HOME: join(paths.cliState, "providers", "codex"),
    SPACE_CODEX_GOALS_DB_PATH: join(paths.data, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(paths.data, "codex-cli-mode-defaults-v1.json"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false"
  };
  const worker = { ...base, ...shared, NODE_ENV: "development" };
  const web = {
    ...base,
    SPACE_WEB_HOST: host,
    SPACE_WEB_PORT: String(ports.web),
    SPACE_WEB_API_ORIGIN: `http://${host}:${ports.api}`
  };
  const cliHost = {
    ...base,
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_MEMORY_ROOT: paths.memory,
    SPACE_CLI_HOST_SOCKET: paths.socket,
    PATH: [paths.bin, vendorBin, base.PATH].filter(Boolean).join(":")
  };
  return { api, worker, web, cliHost, databaseUrl };
}

/** The long-running from-source processes, in start order. */
export function processSpecs(config, envs) {
  const bin = (name) => join(config.root, "node_modules", ".bin", name);
  const node = process.execPath;
  return [
    { name: "cli-host", command: node, args: [join(config.root, "packages", "cli-host", "dist", "main.js")], cwd: config.root, env: envs.cliHost, restartOnRebuild: true },
    { name: "api", command: bin("tsx"), args: ["watch", "--clear-screen=false", "src/server.ts"], cwd: join(config.root, "apps", "api"), env: envs.api, restartOnRebuild: true },
    { name: "worker-build", command: bin("tsc"), args: ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], cwd: join(config.root, "apps", "worker"), env: envs.worker },
    { name: "worker", command: node, args: ["--watch-path=dist", "dist/worker.js"], cwd: join(config.root, "apps", "worker"), env: envs.worker, restartOnRebuild: true },
    { name: "web", command: bin("vite"), args: ["--host", config.host, "--port", String(config.ports.web), "--strictPort"], cwd: join(config.root, "apps", "web"), env: envs.web }
  ];
}

function prefixLines(name, stream, write) {
  let pending = "";
  stream?.setEncoding?.("utf8");
  stream?.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(`[${name}] ${line}\n`);
  });
  stream?.on("end", () => { if (pending) write(`[${name}] ${pending}\n`); });
}

/**
 * Starts the processes and stops all of them when one exits on its own, with a message naming it: a crashed worker is a
 * visible failure, never a silent hang. Resolves with the exit code once everything has stopped.
 */
export function superviseProcesses(specs, { spawn = nodeSpawn, write = (text) => process.stdout.write(text), onStart } = {}) {
  const children = new Map();
  let stopping = false;
  let finished = false;
  let exitCode = 0;
  let resolveDone;
  const done = new Promise((resolveFn) => { resolveDone = resolveFn; });
  const finishIfIdle = () => { if (children.size === 0 && stopping && !finished) { finished = true; resolveDone(exitCode); } };
  const stop = (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    if (code) exitCode = code;
    if (reason) write(`dev-stack: ${reason}\n`);
    for (const child of children.values()) child.kill("SIGTERM");
    finishIfIdle();
  };
  const start = (spec) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    children.set(spec.name, child);
    prefixLines(spec.name, child.stdout, write);
    prefixLines(spec.name, child.stderr, write);
    child.once("error", (error) => {
      if (children.get(spec.name) !== child) return;
      children.delete(spec.name);
      stop(`${spec.name} failed to start (${error.code ?? error.message}). Stopping the dev stack.`, 1);
      finishIfIdle();
    });
    child.once("exit", (code, signal) => {
      if (children.get(spec.name) !== child) return;
      children.delete(spec.name);
      if (!stopping && !child.spaceRestarting) {
        stop(`${spec.name} exited unexpectedly (${code ?? signal}). Stopping the dev stack; see the [${spec.name}] lines above.`, 1);
      }
      finishIfIdle();
    });
    onStart?.(spec, child);
    return child;
  };
  for (const spec of specs) start(spec);
  const restart = (names) => {
    for (const spec of specs.filter((item) => names.includes(item.name))) {
      const child = children.get(spec.name);
      if (!child || stopping) continue;
      child.spaceRestarting = true;
      child.once("exit", () => { if (!stopping) start(spec); });
      child.kill("SIGTERM");
    }
  };
  return { done, stop, restart, children, isRunning: () => !stopping };
}

async function portFree(port, host) {
  return new Promise((resolveFn) => {
    const server = createServer();
    server.once("error", () => resolveFn(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolveFn(true)));
  });
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}).`);
}

export function composeArgs(config, paths, ...rest) {
  return ["compose", "--project-name", config.project, "--file", paths.compose, ...rest];
}

async function waitForReady(url, { timeoutMs = 240_000, isAlive = () => true, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("A dev-stack process stopped before SpaceApp was ready.");
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok === true) return body;
      last = summarizeReadiness(body);
    } catch (error) {
      last = error.cause?.code ?? error.name;
    }
    await new Promise((resolveFn) => setTimeout(resolveFn, 2_000));
  }
  throw new Error(`/readyz did not report ok: true within ${Math.round(timeoutMs / 1000)} s (last: ${last}).`);
}

/** The failing dependencies of a /readyz answer (names and states only, never a value that could hold a secret). */
export function summarizeReadiness(body) {
  const deps = body && typeof body === "object" ? body.dependencies : null;
  if (!deps || typeof deps !== "object") return "no readiness answer";
  const failing = [];
  if (deps.database === "UNAVAILABLE") failing.push("database=UNAVAILABLE (PostgreSQL)");
  if (deps.sessionRevocations && deps.sessionRevocations !== "RUNNING") failing.push(`sessionRevocations=${deps.sessionRevocations}`);
  if (deps.worker && deps.worker !== "disabled" && deps.worker !== "RUNNING") failing.push(`worker=${deps.worker} (Temporal worker or Temporal)`);
  if (deps.cliHost === "UNAVAILABLE") failing.push("cliHost=UNAVAILABLE (CLI host)");
  if (deps.cliAdminHost === "UNAVAILABLE") failing.push("cliAdminHost=UNAVAILABLE");
  if (deps.browserHost && !["in-process", "RUNNING", "DISABLED"].includes(deps.browserHost)) failing.push(`browserHost=${deps.browserHost}`);
  return failing.length ? failing.join(", ") : `ok=${String(body.ok)}`;
}

async function readPid(paths) {
  try {
    const pid = Number((await readFile(paths.pid, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

async function installOpenCode(config, paths) {
  const pin = readOpenCodePackage(await readFile(join(config.root, "Dockerfile"), "utf8"));
  const prefix = join(paths.cliState, "vendor", "opencode");
  const installed = join(prefix, "node_modules", ...pin.name.split("/"), "package.json");
  if (existsSync(installed) && JSON.parse(await readFile(installed, "utf8")).version === pin.version) return pin;
  process.stdout.write(`dev-stack: installing ${pin.spec} into ${prefix} (not globally)\n`);
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  runChecked("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--no-save", "--package-lock=false", pin.spec]);
  return pin;
}

async function writeCliWrapper(config, paths) {
  const wrapper = renderCliWrapper(await readFile(join(config.root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8"), {
    cliStateRoot: paths.cliState,
    deployDockerDir: join(config.root, "deploy", "docker"),
    memoryRoot: paths.memory
  });
  const target = join(paths.bin, "spaceapp-cli-wrapper");
  await writeFile(target, wrapper, { mode: 0o700 });
  await chmod(target, 0o700);
  // Only OpenCode for now (#65); other providers can be added through the same wrapper.
  const link = join(paths.bin, "opencode-vscode-parity");
  if (!await lstat(link).catch(() => null)) await symlink("spaceapp-cli-wrapper", link);
}

export function buildLibraries(root = repoRoot, run = runChecked) {
  for (const name of LIBRARY_PACKAGES) run("npm", ["run", "build", "-w", name], { cwd: root });
}

/**
 * The OpenCode panes share one detached `opencode serve` per provider store (deploy/docker/opencode-shared-server.mjs).
 * In a container it ends with the container; here down/reset stop it, but only a pid that still is `opencode serve` on
 * the recorded port.
 */
export async function stopSharedServers(paths, { run = spawnSync, kill = process.kill.bind(process) } = {}) {
  const stopped = [];
  const providers = await readdir(join(paths.cliState, "providers")).catch(() => []);
  for (const provider of providers) {
    const record = await readFile(join(paths.cliState, "providers", provider, "state", "opencode", "spaceapp-shared-server.json"), "utf8")
      .then(JSON.parse).catch(() => null);
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 1 || !Number.isSafeInteger(record?.port)) continue;
    const args = run("ps", ["-o", "args=", "-p", String(record.pid)], { encoding: "utf8" }).stdout?.trim() ?? "";
    if (!/(?:^|\/)opencode serve\b/.test(args) || !args.includes(`--port ${record.port}`)) continue;
    try { kill(record.pid, "SIGTERM"); stopped.push(record.pid); } catch { /* already gone */ }
  }
  return stopped;
}

async function up(config) {
  if (process.platform === "win32") throw new Error("Run dev:stack inside WSL2 on Windows 11 (see CONTRIBUTING.md).");
  if (await readPid(statePaths(config))) throw new Error("The dev stack is already running. Stop it with: npm run dev:stack -- down");
  runChecked("docker", ["compose", "version"], { stdio: "ignore" });
  for (const [name, port] of Object.entries(config.ports)) {
    if (!await portFree(port, config.host)) throw new Error(`Port ${port} (${name}) on ${config.host} is in use. Set ${PORT_ENV[name]} to another port.`);
  }
  const state = await ensureState(config);
  const { paths } = state;
  const images = readPinnedImages(await readFile(join(config.root, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8"));
  await writeFile(paths.compose, renderCompose({ images, ports: config.ports, host: config.host, secretsDir: paths.secrets, project: config.project }), { mode: 0o600 });
  process.stdout.write(`dev-stack: starting PostgreSQL and Temporal (compose project ${config.project})\n`);
  runChecked("docker", composeArgs(config, paths, "up", "--detach", "--wait"));
  process.stdout.write("dev-stack: building the workspace packages\n");
  buildLibraries(config.root);
  runChecked("npm", ["run", "build", "-w", "@space/worker"], { cwd: config.root });
  const envs = serviceEnvironments(config, state);
  process.stdout.write("dev-stack: running the migrations\n");
  runChecked(process.execPath, [join(config.root, "packages", "db", "dist", "migrate.js")], { cwd: config.root, env: envs.api });
  await installOpenCode(config, paths);
  await writeCliWrapper(config, paths);
  await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
  const supervisor = superviseProcesses(processSpecs(config, envs));
  let rebuildSeen = (await stat(paths.rebuildStamp).catch(() => null))?.mtimeMs ?? 0;
  watchFile(paths.rebuildStamp, { interval: 1000 }, (current) => {
    if (current.mtimeMs > rebuildSeen) {
      rebuildSeen = current.mtimeMs;
      process.stdout.write("dev-stack: packages rebuilt, restarting cli-host, api and worker\n");
      supervisor.restart(["cli-host", "api", "worker"]);
    }
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => supervisor.stop("stopping"));
  const cleanup = async () => { unwatchFile(paths.rebuildStamp); await stopSharedServers(paths); await rm(paths.pid, { force: true }); };
  let readyWatch;
  try {
    await waitForReady(`http://${config.host}:${config.ports.api}/readyz`, { isAlive: supervisor.isRunning });
    process.stdout.write([
      "",
      "SpaceApp is running from source.",
      `  Open:              http://${config.host}:${config.ports.web}`,
      `  Owner setup token: ${state.secrets["setup-token"]}  (one-time: create the owner with it, then sign in)`,
      "  Stop:  npm run dev:stack -- down     Remove everything: npm run dev:stack -- reset",
      ""
    ].join("\n") + "\n");
    // Keep checking: a dependency that goes away later is reported instead of failing silently in the browser.
    let lastReport = "";
    readyWatch = setInterval(async () => {
      try {
        const response = await fetch(`http://${config.host}:${config.ports.api}/readyz`, { signal: AbortSignal.timeout(5_000) });
        const body = await response.json().catch(() => ({}));
        const report = response.ok && body.ok === true ? "" : summarizeReadiness(body);
        if (report !== lastReport) process.stdout.write(report ? `dev-stack: /readyz is failing: ${report}\n` : "dev-stack: /readyz is ok again\n");
        lastReport = report;
      } catch { /* the API restarting under tsx watch; the process supervisor reports real exits */ }
    }, 15_000);
  } catch (error) {
    supervisor.stop(error.message, 1);
  }
  const code = await supervisor.done;
  clearInterval(readyWatch);
  await cleanup();
  process.exitCode = code;
}

async function stopSupervisor(paths) {
  const pid = await readPid(paths);
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && await readPid(paths); i += 1) await new Promise((r) => setTimeout(r, 100));
  }
  await stopSharedServers(paths);
}

async function down(config) {
  const paths = statePaths(config);
  await stopSupervisor(paths);
  if (existsSync(paths.compose)) runChecked("docker", composeArgs(config, paths, "down", "--remove-orphans"));
  process.stdout.write("dev-stack: stopped. Data is kept; `npm run dev:stack -- reset` removes it.\n");
}

async function reset(config) {
  const paths = statePaths(config);
  if (existsSync(config.stateDir) && !existsSync(paths.marker)) {
    throw new Error(`${config.stateDir} was not created by dev:stack; refusing to remove it.`);
  }
  await stopSupervisor(paths);
  if (existsSync(paths.compose)) {
    runChecked("docker", composeArgs(config, paths, "down", "--volumes", "--remove-orphans"));
  }
  if (paths.socketDir !== join(config.stateDir, "run")) await rm(paths.socketDir, { recursive: true, force: true });
  await rm(config.stateDir, { recursive: true, force: true });
  process.stdout.write(`dev-stack: removed the ${config.project} containers, volumes and ${config.stateDir}.\n`);
}

async function rebuild(config) {
  const paths = statePaths(config);
  buildLibraries(config.root);
  await writeFile(paths.rebuildStamp, `${Date.now()}\n`, { mode: 0o600 });
  process.stdout.write((await readPid(paths)) ? "dev-stack: rebuilt; the running stack restarts cli-host, api and worker.\n" : "dev-stack: rebuilt.\n");
}

async function status(config) {
  const paths = statePaths(config);
  const pid = await readPid(paths);
  process.stdout.write(`dev-stack: ${pid ? `running (pid ${pid})` : "not running"}; state ${existsSync(config.stateDir) ? config.stateDir : "absent"}; web http://${config.host}:${config.ports.web}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] ?? "up";
  const config = resolveConfig(env);
  const commands = { up, down, reset, rebuild, status };
  if (!commands[command]) throw new Error(`Unknown dev:stack command "${command}". Use up, down, reset, rebuild or status.`);
  await commands[command](config);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`dev-stack: ${error.message}\n`);
    process.exitCode = 1;
  });
}
