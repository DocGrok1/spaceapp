import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_PORTS, DEFAULT_PROJECT, STATE_MARKER, baseEnv, ensureState, main, processSpecs, readOpenCodePackage, readPinnedImages,
  renderCliWrapper, renderCompose, repoRoot, resolveConfig, serviceEnvironments, statePaths, stopSharedServers, summarizeReadiness,
  superviseProcesses
} from "../dev-stack.mjs";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFile(join(root, path), "utf8");
const mode = async (path) => (await stat(path)).mode & 0o777;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "dev-stack-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the dev stack uses the launcher's digest-pinned postgres and temporal images", async () => {
  const template = await read("packages/run-spaceapp/templates/compose.yml");
  const images = readPinnedImages(template);
  for (const image of Object.values(images)) {
    assert.match(image, /@sha256:[0-9a-f]{64}$/);
    assert.ok(template.includes(`image: ${image}`));
  }
  assert.match(images.postgres, /^pgvector\/pgvector:/);
  assert.match(images.temporal, /^temporalio\/auto-setup:/);
  assert.throws(() => readPinnedImages(template.replace(/(pgvector\/pgvector:[^@\s]+)@sha256:[0-9a-f]+/, "$1")), /digest-pinned image for postgres/);
});

test("OpenCode is pinned to the version the CLI image installs", async () => {
  const pin = readOpenCodePackage(await read("Dockerfile"));
  assert.match(pin.spec, /^(?:@opencode\/cli|opencode-ai)@\d/);
  assert.equal(`${pin.name}@${pin.version}`, pin.spec);
  assert.deepEqual(readOpenCodePackage("RUN npm install --global --no-fund opencode-ai@1.2.3 \\\n"), { spec: "opencode-ai@1.2.3", name: "opencode-ai", version: "1.2.3" });
  assert.throws(() => readOpenCodePackage("RUN npm install --global opencode-ai"), /does not pin/);
});

test("ports, project and state directory are isolated from an installed SpaceApp", () => {
  const config = resolveConfig({}, root);
  assert.deepEqual(config.ports, DEFAULT_PORTS);
  assert.equal(config.project, DEFAULT_PROJECT);
  assert.equal(config.stateDir, join(root, ".dev-stack"));
  assert.equal(config.host, "127.0.0.1");
  for (const port of Object.values(config.ports)) assert.ok(![4910, 4911].includes(port));
  assert.equal(resolveConfig({ SPACE_DEV_STACK_WEB_PORT: "5173" }, root).ports.web, 5173);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_API_PORT: "4910" }, root), /installed SpaceApp/);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_WEB_PORT: "4911" }, root), /installed SpaceApp/);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_WEB_PORT: "4920" }, root), /all be different/);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_API_PORT: "80" }, root), /between 1024/);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_API_PORT: "49x" }, root), /port number/);
  assert.throws(() => resolveConfig({ SPACE_DEV_STACK_PROJECT: "spaceapp" }, root), /installed SpaceApp/);
  for (const dir of [root, resolve(root, ".."), "/", homedir()]) {
    assert.throws(() => resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root), /directory of its own/);
  }
});

test(".dev-stack is git-ignored and npm run dev:stack runs the script", async () => {
  assert.match(await read(".gitignore"), /^\/\.dev-stack\/$/m);
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts["dev:stack"], "node scripts/dev-stack.mjs");
  const ignored = spawnSync("git", ["check-ignore", "-q", ".dev-stack/secrets/setup-token"], { cwd: root });
  if (ignored.error?.code !== "ENOENT") assert.equal(ignored.status, 0);
});

test("the compose file binds every port to 127.0.0.1 and holds no secret value", async (t) => {
  const dir = await scratch(t);
  const config = resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root);
  const { paths, secrets } = await ensureState(config);
  const images = readPinnedImages(await read("packages/run-spaceapp/templates/compose.yml"));
  const compose = renderCompose({ images, ports: config.ports, host: config.host, secretsDir: paths.secrets, project: config.project });
  assert.match(compose, new RegExp(`^name: ${DEFAULT_PROJECT}$`, "m"));
  const portLines = compose.match(/^ {6}- "[^"]*:\d+:\d+"$/gm);
  assert.equal(portLines.length, 2);
  for (const line of portLines) assert.match(line, /^ {6}- "127\.0\.0\.1:\d+:\d+"$/);
  assert.ok(compose.includes(`"127.0.0.1:${config.ports.postgres}:5432"`));
  assert.ok(compose.includes(`"127.0.0.1:${config.ports.temporal}:7233"`));
  assert.ok(compose.includes(images.postgres) && compose.includes(images.temporal));
  for (const value of Object.values(secrets)) assert.ok(!compose.includes(value));
  assert.match(compose, /com\.oll4com\.spaceapp\.dev-stack: "spaceapp-dev-stack"/);
});

test("secrets are generated once per state directory with mode 0600", async (t) => {
  const dir = join(await scratch(t), "state");
  const config = resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root);
  const first = await ensureState(config);
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(first.paths.secrets), 0o700);
  for (const name of ["postgres-password", "session-secret", "setup-token"]) {
    assert.equal(await mode(join(first.paths.secrets, name)), 0o600);
    assert.ok(first.secrets[name].length >= 32, name);
  }
  assert.equal(new Set(Object.values(first.secrets)).size, 3);
  const second = await ensureState(config);
  assert.deepEqual(second.secrets, first.secrets);
  assert.equal((await readFile(join(dir, STATE_MARKER), "utf8")).trim(), DEFAULT_PROJECT);
});

test("a directory dev:stack did not create is never used or removed", async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, "keep.txt"), "owner data\n");
  const config = resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root);
  await assert.rejects(ensureState(config), /not created by dev:stack/);
  await assert.rejects(main(["reset"], { SPACE_DEV_STACK_DIR: dir }), /refusing to remove/);
  assert.ok(existsSync(join(dir, "keep.txt")));
});

test("reset removes only the state directory it created", async (t) => {
  const parent = await scratch(t);
  const dir = join(parent, "state");
  const sibling = join(parent, "sibling.txt");
  await writeFile(sibling, "stays\n");
  await ensureState(resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root));
  const log = t.mock.method(process.stdout, "write", () => true);
  await main(["reset"], { SPACE_DEV_STACK_DIR: dir });
  log.mock.restore();
  assert.equal(existsSync(dir), false);
  assert.ok(existsSync(sibling));
  await assert.rejects(main(["bogus"], { SPACE_DEV_STACK_DIR: dir }), /Unknown dev:stack command/);
});

test("long checkouts put the CLI host socket in a short private directory", () => {
  const short = statePaths(resolveConfig({ SPACE_DEV_STACK_DIR: "/tmp/ds" }, root));
  assert.equal(short.socket, "/tmp/ds/run/cli-host.sock");
  const long = statePaths(resolveConfig({ SPACE_DEV_STACK_DIR: `/tmp/${"x".repeat(120)}` }, root));
  assert.ok(Buffer.byteLength(long.socket) <= 100);
  assert.match(long.socket, /spaceapp-dev-[0-9a-f]{12}\/cli-host\.sock$/);
});

test("the CLI wrapper runs from the state directory and this checkout, not the container paths", async (t) => {
  const dir = await scratch(t);
  const wrapper = renderCliWrapper(await read("deploy/docker/public-cli-wrapper.sh"), {
    cliStateRoot: join(dir, "cli"), deployDockerDir: join(root, "deploy", "docker"), memoryRoot: join(dir, "it's memory")
  });
  assert.match(wrapper, /^set -euo pipefail\nexport SPACE_MEMORY_ROOT='.*it'\\''s memory'$/m);
  assert.doesNotMatch(wrapper, /\/var\/lib\/spaceapp-cli|\/app\/deploy/);
  assert.ok(wrapper.includes(`state_root="${join(dir, "cli")}/providers/$runtime_name"`));
  assert.ok(wrapper.includes(`node ${join(root, "deploy", "docker")}/opencode-shared-server.mjs`));
  assert.ok(wrapper.includes(`export PATH="${join(dir, "cli")}/vendor/$runtime_name/node_modules/.bin:`));
  const file = join(dir, "wrapper.sh");
  await writeFile(file, wrapper);
  const syntax = spawnSync("bash", ["-n", file]);
  assert.equal(syntax.status, 0, syntax.stderr?.toString());
});

test("process environments use owner setup, loopback addresses and none of the caller's SpaceApp settings", async (t) => {
  const dir = await scratch(t);
  const config = resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root);
  const state = await ensureState(config);
  const envs = serviceEnvironments(config, state, { PATH: "/usr/bin", HOME: "/home/x", SPACE_DEV_LOGIN: "true", SPACEAPP_PORT: "4911", SPACE_DATABASE_URL: "postgres://installed" });
  assert.deepEqual(baseEnv({ SPACE_X: "1", SPACEAPP_Y: "2", SPACEX: "3", PATH: "/bin" }), { SPACEX: "3", PATH: "/bin" });
  assert.equal(envs.api.SPACE_DEV_LOGIN, "false");
  assert.equal(envs.api.SPACE_SESSION_SECRET, state.secrets["session-secret"]);
  assert.equal(envs.api.SPACE_SETUP_TOKEN_FILE, join(state.paths.secrets, "setup-token"));
  assert.equal(envs.api.SPACE_API_HOST, "127.0.0.1");
  assert.equal(envs.api.SPACE_API_PORT, String(config.ports.api));
  assert.equal(envs.api.SPACE_TEMPORAL_ADDRESS, `127.0.0.1:${config.ports.temporal}`);
  assert.equal(envs.api.SPACE_DATABASE_URL, `postgres://spaceapp:${encodeURIComponent(state.secrets["postgres-password"])}@127.0.0.1:${config.ports.postgres}/spaceapp`);
  assert.equal(envs.worker.SPACE_DATABASE_URL, envs.api.SPACE_DATABASE_URL);
  assert.equal(envs.api.SPACE_CLI_COMMAND_PATH, state.paths.bin);
  assert.equal(envs.api.SPACE_CLI_HOST_SOCKET, envs.cliHost.SPACE_CLI_HOST_SOCKET);
  assert.equal(envs.web.SPACE_WEB_HOST, "127.0.0.1");
  assert.equal(envs.web.SPACE_WEB_API_ORIGIN, `http://127.0.0.1:${config.ports.api}`);
  assert.ok(envs.cliHost.PATH.startsWith(`${state.paths.bin}:${join(state.paths.cliState, "vendor", "opencode", "node_modules", ".bin")}:`));
  for (const env of [envs.api, envs.worker, envs.web, envs.cliHost]) {
    for (const [key, value] of Object.entries(env)) {
      if (/^SPACE_/.test(key) && value.startsWith("/")) {
        assert.ok(value.startsWith(dir) || value.startsWith(root) || value.startsWith(tmpdir()), `${key}=${value}`);
      }
    }
    assert.notEqual(env.SPACEAPP_PORT, "4911");
  }
  const specs = processSpecs(config, envs);
  assert.deepEqual(specs.map((spec) => spec.name), ["cli-host", "api", "worker-build", "worker", "web"]);
  const web = specs.find((spec) => spec.name === "web");
  assert.deepEqual(web.args, ["--host", "127.0.0.1", "--port", String(config.ports.web), "--strictPort"]);
  assert.deepEqual(specs.find((spec) => spec.name === "api").args.slice(0, 1), ["watch"]);
});

test("down and reset stop the detached OpenCode server only when the recorded pid still is it", async (t) => {
  const dir = await scratch(t);
  const { paths } = await ensureState(resolveConfig({ SPACE_DEV_STACK_DIR: dir }, root));
  const record = join(paths.cliState, "providers", "opencode", "state", "opencode");
  await mkdir(record, { recursive: true });
  await writeFile(join(record, "spaceapp-shared-server.json"), JSON.stringify({ pid: 4242, port: 47047 }));
  const killed = [];
  const kill = (pid, signal) => killed.push([pid, signal]);
  const ps = (args) => () => ({ stdout: `${args}\n` });
  assert.deepEqual(await stopSharedServers(paths, { run: ps("/x/node_modules/.bin/opencode serve --hostname 127.0.0.1 --port 47047"), kill }), [4242]);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  assert.deepEqual(await stopSharedServers(paths, { run: ps("vim notes.txt"), kill }), []);
  assert.deepEqual(await stopSharedServers(paths, { run: ps("opencode serve --hostname 127.0.0.1 --port 5000"), kill }), []);
  assert.equal(killed.length, 1);
});

test("a /readyz failure names the dependency that is down", () => {
  assert.equal(summarizeReadiness({ ok: true, dependencies: { database: "RUNNING", sessionRevocations: "RUNNING", worker: "RUNNING", cliHost: "RUNNING", browserHost: "DISABLED" } }), "ok=true");
  assert.equal(summarizeReadiness({ ok: false, dependencies: { database: "RUNNING", sessionRevocations: "RUNNING", worker: "ERROR", cliHost: "UNAVAILABLE", browserHost: "DISABLED" } }),
    "worker=ERROR (Temporal worker or Temporal), cliHost=UNAVAILABLE (CLI host)");
  assert.equal(summarizeReadiness("nope"), "no readiness answer");
});

function nodeChild(code, delayMs) {
  return { command: process.execPath, args: ["-e", `console.log("up"); setTimeout(() => process.exit(${code}), ${delayMs})`], cwd: root, env: { PATH: process.env.PATH } };
}

test("one process exiting stops the whole stack with a message naming it, instead of hanging", async () => {
  const lines = [];
  const supervisor = superviseProcesses([
    { name: "api", ...nodeChild(0, 60_000) },
    { name: "worker", ...nodeChild(3, 300) },
    { name: "web", ...nodeChild(0, 60_000) }
  ], { spawn, write: (text) => lines.push(text) });
  const code = await supervisor.done;
  assert.equal(code, 1);
  assert.equal(supervisor.children.size, 0);
  const output = lines.join("");
  assert.match(output, /dev-stack: worker exited unexpectedly \(3\)\. Stopping the dev stack/);
  assert.match(output, /\[api\] up\n/);
});

test("a missing executable is a clear start failure", async () => {
  const lines = [];
  const supervisor = superviseProcesses([{ name: "cli-host", command: join(root, "does-not-exist"), args: [], cwd: root, env: {} }], { spawn, write: (text) => lines.push(text) });
  assert.equal(await supervisor.done, 1);
  assert.match(lines.join(""), /cli-host failed to start \(ENOENT\)/);
});

test("rebuild restarts the named processes without stopping the stack, and stop ends everything", async () => {
  const lines = [];
  let starts = 0;
  const supervisor = superviseProcesses([
    { name: "api", ...nodeChild(0, 60_000) },
    { name: "web", ...nodeChild(0, 60_000) }
  ], { spawn, write: (text) => lines.push(text), onStart: (spec) => { if (spec.name === "api") starts += 1; } });
  const firstApi = supervisor.children.get("api");
  supervisor.restart(["api"]);
  for (let i = 0; i < 100 && starts < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(starts, 2);
  assert.notEqual(supervisor.children.get("api"), firstApi);
  assert.ok(supervisor.isRunning());
  supervisor.stop("stopping");
  assert.equal(await supervisor.done, 0);
  assert.doesNotMatch(lines.join(""), /exited unexpectedly/);
});

test("the dev-stack script is importable without starting anything", () => {
  assert.equal(repoRoot, root);
});
