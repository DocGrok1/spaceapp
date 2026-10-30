#!/usr/bin/env node
// CI check of npm run dev:stack (#65), without a TTY: start the stack, wait for /readyz, create the owner over HTTP with
// the setup token, open an OpenCode pane through the API and check that its CLI session runs, then reset and check that
// no container, volume or process of the dev stack is left.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { repoRoot, resolveConfig, statePaths } from "./dev-stack.mjs";

const config = resolveConfig(process.env);
const paths = statePaths(config);
const api = `http://${config.host}:${config.ports.api}`;
const web = `http://${config.host}:${config.ports.web}`;
const label = `com.oll4com.spaceapp.dev-stack=${config.project}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => process.stdout.write(`dev-stack-ci: ${text}\n`);

async function until(what, check, timeoutMs, isAlive = () => true) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error(`dev:stack exited while waiting for ${what}.`);
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${last.message})` : ""}.`);
}

function leftovers() {
  const containers = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=${label}`], { encoding: "utf8" }).stdout?.trim() ?? "";
  const volumes = spawnSync("docker", ["volume", "ls", "-q", "--filter", `label=${label}`], { encoding: "utf8" }).stdout?.trim() ?? "";
  const processes = (spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout ?? "").split("\n")
    .filter((line) => line.includes(config.stateDir) || line.includes(paths.socket) || /scripts\/dev-stack\.mjs up/.test(line))
    .filter((line) => !line.includes("dev-stack-ci.mjs") && !line.includes(" ps -eo"));
  return { containers, volumes, processes, stateDir: existsSync(config.stateDir) };
}

async function main() {
  step("starting npm run dev:stack");
  const stack = spawn(process.execPath, [join(repoRoot, "scripts", "dev-stack.mjs"), "up"], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
  let stackExited = false;
  stack.once("exit", () => { stackExited = true; });
  const alive = () => !stackExited;
  let failure;
  try {
    await until("/readyz ok: true", async () => (await (await fetch(`${api}/readyz`)).json()).ok === true, 20 * 60_000, alive);
    step("/readyz reports ok: true");
    const webIndex = await fetch(web);
    if (!webIndex.ok) throw new Error(`The Vite dev server answered ${webIndex.status}.`);
    const token = (await readFile(join(paths.secrets, "setup-token"), "utf8")).trim();
    // Through the Vite dev server, as a browser would, so the proxy is part of the check.
    const claim = await fetch(`${web}/api/setup/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@dev-stack.invalid", password: `dev-stack-${token.slice(0, 16)}` })
    });
    if (!claim.ok) throw new Error(`Owner setup failed: HTTP ${claim.status}.`);
    const { starterRoomId } = await claim.json();
    const cookie = claim.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    step("owner created with the setup token");
    const csrf = await (await fetch(`${web}/api/auth/csrf`, { headers: { cookie } })).json();
    const headers = { cookie, "content-type": "application/json", [csrf.headerName]: csrf.csrfToken };
    const created = await fetch(`${web}/api/rooms/${encodeURIComponent(starterRoomId)}/panes`, {
      method: "POST", headers, body: JSON.stringify({ panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:opencode" }] })
    });
    if (!created.ok) throw new Error(`Opening the OpenCode pane failed: HTTP ${created.status} ${await created.text()}`);
    const paneId = (await created.json()).data[0].id;
    const session = await fetch(`${web}/api/panes/${encodeURIComponent(paneId)}/cli/session`, { method: "POST", headers, body: JSON.stringify({ runtimeId: "cli:opencode" }) });
    if (!session.ok) throw new Error(`Starting the OpenCode CLI session failed: HTTP ${session.status} ${await session.text()}`);
    const running = await until("the OpenCode pane to run", async () => {
      const current = await (await fetch(`${web}/api/panes/${encodeURIComponent(paneId)}/cli/session`, { headers: { cookie } })).json();
      if (current?.status === "ERROR" || current?.status === "EXITED") throw new Error(`OpenCode pane ${current.status}: ${current.statusReason}`);
      return current?.status === "RUNNING" ? current : null;
    }, 3 * 60_000, alive);
    step(`OpenCode pane ${paneId} is ${running.status}`);
  } catch (error) {
    failure = error;
  } finally {
    step("npm run dev:stack -- reset");
    const reset = spawnSync(process.execPath, [join(repoRoot, "scripts", "dev-stack.mjs"), "reset"], { cwd: repoRoot, stdio: "inherit" });
    await until("dev:stack to stop", () => stackExited, 60_000).catch((error) => { failure ??= error; stack.kill("SIGKILL"); });
    if (reset.status !== 0) failure ??= new Error(`reset failed with exit ${reset.status}.`);
  }
  const left = leftovers();
  step(`after reset: containers=[${left.containers}] volumes=[${left.volumes}] processes=${left.processes.length} stateDir=${left.stateDir}`);
  if (left.containers || left.volumes || left.processes.length || left.stateDir) {
    for (const line of left.processes) step(`left: ${line}`);
    failure ??= new Error("reset left containers, volumes, processes or the state directory behind.");
  }
  if (failure) throw failure;
  step("passed");
}

main().catch((error) => {
  process.stderr.write(`dev-stack-ci: ${error.message}\n`);
  process.exitCode = 1;
});
