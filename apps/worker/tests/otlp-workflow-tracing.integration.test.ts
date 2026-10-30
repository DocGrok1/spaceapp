// One connected OTLP trace from an API request through Temporal workflows,
// child workflows and every activity attempt, across the three worker
// processes' task queues. Runs real production workflows with stub activities
// on the @temporalio/testing time-skipping server and a local fake collector.
// No Docker, database or AI provider is used.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker, type WorkerOptions } from "@temporalio/worker";
import { formatTraceparent, buildCodexAppServerTurnWorkflowId, buildRoomAgentSupervisorWorkflowId } from "@space/contracts";
import { createOtlpSpanExporter, type ServerSpan, type SpanExporter } from "@space/runtime";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { SPAN_ATTRIBUTE_ALLOWLIST } from "../src/trace-carrier.js";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { startFakeOtlpCollector, type CollectedSpan, type FakeOtlpCollector } from "./support/fake-otlp-collector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const src = (name: string) => path.join(here, "../src", name);
const MAIN_QUEUE = "space-tracing-test";

// Inside the workflow bundle, @space/* resolves to this checkout's sources.
const bundlerOptions: WorkerOptions["bundlerOptions"] = {
  webpackConfigHook: (config) => {
    const alias: Record<string, string> = {};
    for (const name of readdirSync(path.join(repoRoot, "packages"))) {
      const entry = path.join(repoRoot, "packages", name, "src", "index.ts");
      if (existsSync(entry)) alias[`@space/${name}$`] = entry;
    }
    return { ...config, resolve: { ...config.resolve, alias: { ...(config.resolve?.alias as object), ...alias } } };
  }
};

// Sensitive-looking text placed in every input and error. None of it may be exported.
const PRIVATE = "secret prompt text https://private.example/a?token=sk-live-1 /home/operator/notes.txt";
const hex = (n: number, seed: string) => seed.repeat(n).slice(0, n);
const apiTraceId = (seed: string) => hex(32, seed);
const apiSpanId = (seed: string) => hex(16, seed);

function turn(seed: string, overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room:tracing-01", paneId: "pane:tracing-01", prompt: PRIVATE, artifactIds: [],
    providerId: "codex", traceId: `req:tracing-${seed}`, agentRunId: `agent_run:tracing-${seed}`,
    permissionMode: null, collaborationMode: "default",
    traceparent: formatTraceparent(apiTraceId(seed), apiSpanId(seed)),
    ...overrides
  };
}

const memoFor = (seed: string) => ({ spaceTraceId: `req:tracing-${seed}`, traceparent: formatTraceparent(apiTraceId(seed), apiSpanId(seed)), w3cTraceId: apiTraceId(seed) });

let env: TestWorkflowEnvironment;
let collector: FakeOtlpCollector;
const exporters: SpanExporter[] = [];
const workers: Worker[] = [];
const running: Promise<void>[] = [];
const calls = { turnAttempts: 0, dotSteps: 0, finished: [] as string[] };

function exporterFor(service: string, endpoint: string, extra: Partial<Parameters<typeof createOtlpSpanExporter>[0]> = {}) {
  const exporter = createOtlpSpanExporter({ endpoint, serviceName: service, flushIntervalMs: 50, ...extra });
  exporters.push(exporter);
  return exporter;
}

async function startWorker(options: Omit<WorkerOptions, "connection" | "namespace">) {
  const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace ?? "default", bundlerOptions, ...options });
  workers.push(worker);
  running.push(worker.run());
  return worker;
}

const mainActivities = {
  async runCodexAppServerTurn() {
    calls.turnAttempts += 1;
    if (calls.turnAttempts === 1) {
      // A retryable failure whose message carries private text: only its stable type may be exported.
      throw ApplicationFailure.retryable(`upstream failed for ${PRIVATE}`, "CODEX_APP_SERVER_UNAVAILABLE");
    }
    return { status: "COMPLETED", message: "done", roomAgentOutcome: { status: "VERIFIED", statusReason: "Verified." } };
  },
  async checkRoomAgentSupervisorTurn() { return "READY"; },
  async discardRoomAgentSupervisorTurn() { return undefined; },
  async finishRoomAgentSupervisorTurn(input: { item: { turn: { agentRunId: string } } }) { calls.finished.push(input.item.turn.agentRunId); },
  async prepareRoomAgentBackgroundContinuation() { return { state: "DONE" }; },
  async runRoomAgentBackgroundAction() { return { status: "COMPLETED" }; },
  async dotGoalStep() {
    calls.dotSteps += 1;
    // 300 waiting steps end the first run (continue-as-new); the next run finishes.
    return calls.dotSteps <= 300 ? { state: "WAITING", runId: null, goalStatus: "RUNNING" } : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  },
  async dotGoalObserve() { return { run: "COMPLETED", goalStatus: "RUNNING" }; }
};

const maintenanceActivities = {
  async refreshMemoryGraphSnapshot() { return { sourceHash: "hash:tracing", status: "REFRESHED" }; },
  async refreshAllMonthsMemoryGraphSnapshot() { return undefined; },
  async reconcileStaleSpaceAgentSessions() { return undefined; },
  async createScheduledMemoryAudit() { return { id: "memory_run:tracing-1", workflowId: "space-memory-consolidation:tracing-1" }; },
  async prepareMemoryConsolidation() { return { run: { id: "memory_run:tracing-1" }, changeSetId: "memory_change:tracing-1" }; },
  async finalizeMemoryRepair() { return { id: "memory_run:tracing-1", status: "COMPLETED" }; }
};

const mutationActivities = {
  async executePersistedMemoryChangeSet() { return { status: "APPLIED", changeSetId: "memory_change:tracing-1" }; }
};

async function spansWhere(predicate: (spans: CollectedSpan[]) => boolean, timeoutMs = 20_000): Promise<CollectedSpan[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all(exporters.map((exporter) => exporter.flush()));
    if (predicate(collector.spans)) return collector.spans;
    if (Date.now() > deadline) throw new Error(`Spans did not arrive: ${JSON.stringify(collector.spans.map((s) => s.name))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const inTrace = (traceId: string) => collector.spans.filter((span) => span.traceId === traceId);
const named = (spans: CollectedSpan[], name: string) => spans.filter((span) => span.name === name);

beforeAll(async () => {
  try { Runtime.install({ logger: new DefaultLogger("WARN") }); } catch { /* already installed in this process */ }
  collector = await startFakeOtlpCollector();
  env = await TestWorkflowEnvironment.createTimeSkipping();
  // The three worker processes, each with its own exporter (service name) as in production.
  await startWorker({ taskQueue: MAIN_QUEUE, workflowsPath: src("workflows.ts"), activities: mainActivities,
    ...workerTracingOptions(exporterFor("space-worker", collector.endpoint)) });
  await startWorker({ taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowsPath: src("memory-maintenance-workflows.ts"), activities: maintenanceActivities,
    ...workerTracingOptions(exporterFor("space-memory-maintenance-worker", collector.endpoint)) });
  await startWorker({ taskQueue: MEMORY_MUTATION_TASK_QUEUE, workflowsPath: src("memory-mutation-workflows.ts"), activities: mutationActivities,
    ...workerTracingOptions(exporterFor("space-memory-mutation-worker", collector.endpoint)) });
}, 180_000);

afterAll(async () => {
  for (const worker of workers) worker.shutdown();
  await Promise.allSettled(running);
  await Promise.allSettled(exporters.map((exporter) => exporter.close()));
  await env?.teardown();
  await collector?.close();
}, 60_000);

describe("OTLP worker and workflow spans", () => {
  it("connects the API span, the turn workflow and every activity attempt in one trace", async () => {
    const input = turn("a");
    const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      taskQueue: MAIN_QUEUE, workflowId: buildCodexAppServerTurnWorkflowId(input), args: [input], memo: memoFor("a")
    });
    expect(result).toMatchObject({ status: "COMPLETED" });
    await spansWhere(() => named(inTrace(apiTraceId("a")), "activity runCodexAppServerTurn").length === 2 && named(inTrace(apiTraceId("a")), "workflow codexAppServerTurnWorkflow").length === 1);
    const trace = inTrace(apiTraceId("a"));
    const [workflow] = named(trace, "workflow codexAppServerTurnWorkflow");
    expect(workflow).toMatchObject({ service: "space-worker", kind: 1, parentSpanId: apiSpanId("a"), status: 0 });
    expect(workflow!.attributes).toMatchObject({ "space.workflow_type": "codexAppServerTurnWorkflow", "space.outcome": "COMPLETED", "space.trace_id": "req:tracing-a", "space.room_id": "room:tracing-01" });
    const attempts = named(trace, "activity runCodexAppServerTurn").sort((a, b) => Number(a.attributes["space.attempt"]) - Number(b.attributes["space.attempt"]));
    expect(attempts.map((span) => span.parentSpanId)).toEqual([workflow!.spanId, workflow!.spanId]);
    expect(attempts[0]!.attributes).toMatchObject({ "space.attempt": 1, "space.outcome": "FAILED", "space.reason_code": "CODEX_APP_SERVER_UNAVAILABLE", "space.category": "UPSTREAM_UNAVAILABLE" });
    expect(attempts[0]!.status).toBe(2);
    expect(attempts[1]!.attributes).toMatchObject({ "space.attempt": 2, "space.outcome": "COMPLETED" });
    expect(new Set(attempts.map((span) => span.spanId)).size).toBe(2);
  }, 60_000);

  it("parents a Room Agent action workflow to the request span named in its memo", async () => {
    await env.client.workflow.execute("roomAgentActionWorkflow", {
      taskQueue: MAIN_QUEUE, workflowId: "space-room-action:action_tracing-1",
      args: [{ actionId: "action_tracing-1", traceId: "req:tracing-9", bridge: { roomId: "room:tracing-01", missionId: "mission:tracing-1", prompt: PRIVATE, backgroundExecution: true } }],
      memo: memoFor("9")
    });
    await spansWhere(() => named(inTrace(apiTraceId("9")), "activity runRoomAgentBackgroundAction").length === 1 && named(inTrace(apiTraceId("9")), "workflow roomAgentActionWorkflow").length === 1);
    const trace = inTrace(apiTraceId("9"));
    const [workflow] = named(trace, "workflow roomAgentActionWorkflow");
    const [activity] = named(trace, "activity runRoomAgentBackgroundAction");
    expect(workflow).toMatchObject({ service: "space-worker", parentSpanId: apiSpanId("9"), status: 0 });
    expect(workflow!.attributes).toMatchObject({ "space.workflow_type": "roomAgentActionWorkflow", "space.outcome": "COMPLETED" });
    expect(activity).toMatchObject({ parentSpanId: workflow!.spanId });
    expect(activity!.attributes).toMatchObject({ "space.attempt": 1, "space.outcome": "COMPLETED" });
  }, 60_000);

  it("nests child workflows under their parent across the maintenance and mutation workers", async () => {
    await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: "space-memory-maintenance:tracing", args: [{ traceId: "req:tracing-m" }], memo: memoFor("b")
    });
    await spansWhere(() => named(inTrace(apiTraceId("b")), "activity executePersistedMemoryChangeSet").length === 1 && named(inTrace(apiTraceId("b")), "workflow memoryMaintenanceWorkflow").length === 1);
    const trace = inTrace(apiTraceId("b"));
    const [maintenance] = named(trace, "workflow memoryMaintenanceWorkflow");
    const [consolidation] = named(trace, "workflow memoryConsolidationWorkflow");
    expect(maintenance).toMatchObject({ parentSpanId: apiSpanId("b"), service: "space-memory-maintenance-worker" });
    expect(consolidation).toMatchObject({ parentSpanId: maintenance!.spanId });
    expect(consolidation!.attributes["space.parent_workflow_id"]).toBe("space-memory-maintenance:tracing");
    for (const name of ["refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions", "createScheduledMemoryAudit"]) {
      expect(named(trace, `activity ${name}`)[0]?.parentSpanId).toBe(maintenance!.spanId);
    }
    expect(named(trace, "activity prepareMemoryConsolidation")[0]?.parentSpanId).toBe(consolidation!.spanId);
    expect(named(trace, "activity finalizeMemoryRepair")[0]?.parentSpanId).toBe(consolidation!.spanId);
    // Scheduled by the consolidation workflow, executed by the mutation worker.
    expect(named(trace, "activity executePersistedMemoryChangeSet")[0]).toMatchObject({ parentSpanId: consolidation!.spanId, service: "space-memory-mutation-worker" });
  }, 60_000);

  it("traces each Room Agent mission turn in its request's trace and links background continuations", async () => {
    const roomId = "room:tracing-01";
    const workflowId = buildRoomAgentSupervisorWorkflowId(roomId);
    const operator = { missionId: "mission:tracing-1", turn: turn("c", { roomAgentMissionId: "mission:tracing-1", agentRunId: "agent_run:tracing-op" }) };
    const handle = await env.client.workflow.signalWithStart("roomAgentSupervisorWorkflow", {
      taskQueue: MAIN_QUEUE, workflowId, args: [{ roomId, pending: [], processedCount: 0 }],
      signal: "enqueueRoomAgentMission", signalArgs: [operator]
    });
    // A background continuation carries no traceparent of its own, only the link source.
    const continuationTurn: Record<string, unknown> = turn("d", {
      roomAgentMissionId: "mission:tracing-1", agentRunId: "agent_run:bg-tracing-1", traceId: "trace:bg-tracing-1",
      roomAgentContinuation: { sourceRunId: "agent_run:tracing-op", generation: 1, sourceTraceparent: formatTraceparent(apiTraceId("c"), apiSpanId("c")) }
    });
    delete continuationTurn.traceparent;
    await spansWhere(() => calls.finished.includes("agent_run:tracing-op") && named(inTrace(apiTraceId("c")), "workflow roomAgentSupervisorWorkflow mission").length === 1);
    await handle.signal("enqueueRoomAgentMission", { missionId: "mission:tracing-1", turn: continuationTurn });
    const continuationSpans = () => collector.spans.filter((span) => span.name === "workflow roomAgentSupervisorWorkflow mission" && span.attributes["space.agent_run_id"] === "agent_run:bg-tracing-1");
    await spansWhere(() => continuationSpans().length === 1 && collector.spans.some((span) => span.traceId === continuationSpans()[0]!.traceId && span.name === "activity runCodexAppServerTurn"));
    await handle.terminate("test finished");

    const request = inTrace(apiTraceId("c"));
    const [mission] = named(request, "workflow roomAgentSupervisorWorkflow mission");
    expect(mission).toMatchObject({ parentSpanId: apiSpanId("c") });
    expect(mission!.attributes).toMatchObject({ "space.mission_id": "mission:tracing-1", "space.workflow_id": workflowId });
    const [child] = named(request, "workflow codexAppServerTurnWorkflow");
    expect(child!.parentSpanId).toBe(mission!.spanId);
    expect(named(request, "activity checkRoomAgentSupervisorTurn")[0]?.parentSpanId).toBe(mission!.spanId);
    expect(named(request, "activity finishRoomAgentSupervisorTurn")[0]?.parentSpanId).toBe(mission!.spanId);
    expect(named(request, "activity runCodexAppServerTurn")[0]?.parentSpanId).toBe(child!.spanId);
    // The mission scope links to the long-lived supervisor run.
    expect(mission!.links).toEqual([expect.objectContaining({ attributes: expect.objectContaining({ "space.link_type": "parent_workflow" }) })]);

    // trace:bg-<id>: a new trace whose spans link back to the request it continues.
    const [continuation] = continuationSpans();
    expect(continuation!.traceId).not.toBe(apiTraceId("c"));
    expect(continuation!.parentSpanId).toBeNull();
    expect(continuation!.attributes["space.continuation_generation"]).toBe(1);
    expect(continuation!.links).toContainEqual({ traceId: apiTraceId("c"), spanId: apiSpanId("c"), attributes: { "space.link_type": "background_continuation" } });
    const continued = inTrace(continuation!.traceId);
    const [continuedTurn] = named(continued, "workflow codexAppServerTurnWorkflow");
    expect(continuedTurn!.parentSpanId).toBe(continuation!.spanId);
    expect(continuedTurn!.links).toContainEqual({ traceId: apiTraceId("c"), spanId: apiSpanId("c"), attributes: { "space.link_type": "background_continuation" } });
  }, 60_000);

  it("links a continue-as-new run to the run it continues", async () => {
    const result = await env.client.workflow.execute("dotGoalWorkflow", {
      taskQueue: MAIN_QUEUE, workflowId: "space-dot-goal:tracing", args: [{ goalId: "dot_goal:tracing-1" }], memo: memoFor("e")
    });
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    await spansWhere(() => named(inTrace(apiTraceId("e")), "workflow dotGoalWorkflow").length === 2);
    const runs = named(inTrace(apiTraceId("e")), "workflow dotGoalWorkflow");
    const first = runs.find((span) => span.attributes["space.outcome"] === "CONTINUED_AS_NEW")!;
    const second = runs.find((span) => span.attributes["space.outcome"] === "COMPLETED")!;
    expect(first.parentSpanId).toBe(apiSpanId("e"));
    expect(second.parentSpanId).toBe(apiSpanId("e"));
    expect(second.attributes["space.continued_from_run_id"]).toBe(first.attributes["space.run_id"]);
    expect(second.links).toEqual([{ traceId: first.traceId, spanId: first.spanId,
      attributes: { "space.link_type": "continue_as_new", "space.run_id": first.attributes["space.run_id"] } }]);
    expect(named(inTrace(apiTraceId("e")), "activity dotGoalStep").filter((span) => span.parentSpanId === second.spanId)).toHaveLength(1);
  }, 120_000);

  it("emits no spans when a recorded history is replayed", async () => {
    const replayed: ServerSpan[] = [];
    const counting: SpanExporter = { record: (span) => { replayed.push(span); }, flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
    const traced = workerTracingOptions(counting);
    const cases: Array<[string, string]> = [
      [buildCodexAppServerTurnWorkflowId(turn("a")), "workflows.ts"],
      ["space-memory-maintenance:tracing", "memory-maintenance-workflows.ts"],
      ["space-memory-consolidation:tracing-1", "memory-maintenance-workflows.ts"]
    ];
    for (const [workflowId, file] of cases) {
      const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
      // With tracing installed: replay succeeds (deterministic) and records nothing.
      await Worker.runReplayHistory({ workflowsPath: src(file), bundlerOptions, interceptors: traced.interceptors, sinks: traced.sinks }, history);
      // Without tracing: the same history replays too, so export can be switched on or off at any time.
      await Worker.runReplayHistory({ workflowsPath: src(file), bundlerOptions }, history);
    }
    expect(replayed).toEqual([]);
  }, 180_000);

  it("exports only allowlisted attributes and never private text", () => {
    expect(collector.spans.length).toBeGreaterThan(10);
    const allowed = new Set(Object.keys(SPAN_ATTRIBUTE_ALLOWLIST));
    for (const span of collector.spans) {
      for (const key of Object.keys(span.attributes)) expect(allowed.has(key), `${span.name}: ${key}`).toBe(true);
      for (const link of span.links) for (const key of Object.keys(link.attributes)) expect(allowed.has(key)).toBe(true);
    }
    const exported = JSON.stringify(collector.spans);
    for (const fragment of ["secret prompt", "https://", "private.example", "/home/", "token=", "sk-live", "upstream failed"]) {
      expect(exported).not.toContain(fragment);
    }
  });

  it("does not delay or fail workflow work when the collector hangs", async () => {
    const hanging = await startFakeOtlpCollector({ hang: true });
    const exporter = createOtlpSpanExporter({ endpoint: hanging.endpoint, serviceName: "space-worker", flushIntervalMs: 20, timeoutMs: 200, maxQueue: 2 });
    const queue = "space-tracing-hanging";
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace ?? "default", bundlerOptions, taskQueue: queue,
      workflowsPath: src("workflows.ts"), activities: mainActivities, ...workerTracingOptions(exporter) });
    calls.turnAttempts = 1; // succeed on the first attempt
    try {
      const input = turn("f");
      const started = Date.now();
      const result = await worker.runUntil(env.client.workflow.execute("codexAppServerTurnWorkflow", {
        taskQueue: queue, workflowId: buildCodexAppServerTurnWorkflowId(input), args: [input], memo: memoFor("f")
      }));
      expect(result).toMatchObject({ status: "COMPLETED" });
      expect(Date.now() - started).toBeLessThan(10_000);
      await exporter.close();
      // The POSTs timed out and were counted; nothing was thrown into the workflow.
      expect(exporter.stats().failed + exporter.stats().dropped).toBeGreaterThan(0);
      expect(exporter.stats().exported).toBe(0);
    } finally {
      await hanging.close();
    }
  }, 60_000);
});
