import { describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import type { SpanExporter, ServerSpan } from "@space/runtime";
import {
  SPACE_TRACE_HEADER,
  SPAN_ATTRIBUTE_ALLOWLIST,
  allowlistSpanAttributes,
  continuationFromArgs,
  correlationAttributes,
  deterministicSpanId,
  deterministicTraceId,
  readTraceHeader,
  traceparentFromArgs,
  withTraceHeader
} from "../src/trace-carrier.js";
import { createWorkflowTracingSinks, workerTracingOptions, workflowSpanToServerSpan } from "../src/worker-tracing.js";
import type { WorkflowSpanRecord } from "../src/workflow-tracing.js";

const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
const PRIVATE = ["Summarize my secret plan", "https://example.com/x?token=1", "/home/operator/.ssh/id_rsa", "Error: ENOENT open '/var/lib/x'"];

function recorder() {
  const spans: ServerSpan[] = [];
  const exporter: SpanExporter = { record: (span) => { spans.push(span); }, flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
  return { spans, exporter };
}

const record = (overrides: Partial<WorkflowSpanRecord> = {}): WorkflowSpanRecord => ({
  traceId: "a".repeat(32), spanId: "c".repeat(16), parentSpanId: "b".repeat(16), name: "workflow codexAppServerTurnWorkflow",
  startTimeMs: 1_000, endTimeMs: 1_500, error: false, attributes: { "space.workflow_type": "codexAppServerTurnWorkflow" }, links: [], ...overrides
});

describe("span attribute allowlist", () => {
  it("keeps only allowlisted keys with safe values", () => {
    const attributes = allowlistSpanAttributes({
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.room_id": "room:01",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TIMEOUT",
      "space.category": "TIMEOUT",
      prompt: PRIVATE[0],
      "space.error_message": PRIVATE[3],
      "space.pane_id": PRIVATE[2],
      "space.workflow_id": PRIVATE[1],
      "space.reason_code_bad": "x",
      "space.outcome_bad": "maybe",
      "space.duration_ms": -1
    });
    expect(attributes).toEqual({
      "space.workflow_type": "codexAppServerTurnWorkflow", "space.room_id": "room:01", "space.attempt": 2,
      "space.outcome": "FAILED", "space.reason_code": "CODEX_APP_SERVER_TIMEOUT", "space.category": "TIMEOUT"
    });
  });

  it("rejects free text, URLs, paths and messages for every allowlisted key", () => {
    for (const key of Object.keys(SPAN_ATTRIBUTE_ALLOWLIST)) {
      for (const value of PRIVATE) expect(allowlistSpanAttributes({ [key]: value })).toEqual({});
    }
  });

  it("reads only identifiers from workflow arguments", () => {
    expect(correlationAttributes([{ prompt: PRIVATE[0], roomId: "room:01", turn: { paneId: "pane:01", traceId: "req:abcdefgh", developerContext: PRIVATE[1] } }]))
      .toEqual({ "space.room_id": "room:01", "space.pane_id": "pane:01", "space.trace_id": "req:abcdefgh" });
    expect(traceparentFromArgs([{ turn: { traceparent } }])?.parentId).toBe("b".repeat(16));
    expect(continuationFromArgs([{ turn: { roomAgentContinuation: { sourceRunId: "agent_run:1", generation: 2, sourceTraceparent: traceparent } } }]))
      .toEqual({ traceparent, sourceRunId: "agent_run:1", generation: 2 });
  });
});

describe("trace header", () => {
  it("round-trips the carrier and ignores malformed values", () => {
    const headers = withTraceHeader({ other: defaultPayloadConverter.toPayload("kept") }, {
      traceparent, links: [{ traceparent, type: "continue_as_new", runId: "run-1" }]
    });
    expect(Object.keys(headers).sort()).toEqual(["other", SPACE_TRACE_HEADER]);
    expect(readTraceHeader(headers)).toEqual({ traceparent, links: [{ traceparent, type: "continue_as_new", runId: "run-1" }] });
    expect(readTraceHeader({ [SPACE_TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceparent: PRIVATE[0], links: [{ traceparent: "x", type: "y" }] }) }))
      .toEqual({ traceparent: null });
    expect(readTraceHeader({})).toBeNull();
  });

  it("derives stable W3C ids without a random source", () => {
    expect(deterministicSpanId("workflow/run-1")).toBe(deterministicSpanId("workflow/run-1"));
    expect(deterministicSpanId("workflow/run-1")).not.toBe(deterministicSpanId("workflow/run-2"));
    expect(deterministicSpanId("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(deterministicTraceId("x")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("worker tracing options", () => {
  it("installs no workflow interceptor or sink when export is off", () => {
    const options = workerTracingOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors?.workflowModules).toBeUndefined();
    expect(options.interceptors?.activity).toHaveLength(1);
  });

  it("registers the workflow module and a replay-suppressed sink when export is on", () => {
    const options = workerTracingOptions(recorder().exporter);
    expect(options.interceptors?.workflowModules?.[0]).toMatch(/workflow-tracing\.(js|ts)$/);
    expect(options.sinks?.spaceTracing?.recordSpan?.callDuringReplay).toBe(false);
  });

  it("records each workflow span once, even when a retried workflow task repeats it", () => {
    const { spans, exporter } = recorder();
    const sinks = createWorkflowTracingSinks(exporter);
    const fn = sinks.spaceTracing!.recordSpan!.fn as (info: unknown, span: WorkflowSpanRecord) => void;
    fn({}, record());
    fn({}, record());
    fn({}, record({ spanId: "d".repeat(16) }));
    expect(spans.map((span) => span.spanId)).toEqual(["c".repeat(16), "d".repeat(16)]);
  });

  it("never throws into the workflow when recording fails", () => {
    const sinks = createWorkflowTracingSinks({ ...recorder().exporter, record: () => { throw new Error("collector down"); } });
    const fn = sinks.spaceTracing!.recordSpan!.fn as (info: unknown, span: WorkflowSpanRecord) => void;
    expect(() => fn({}, record())).not.toThrow();
  });

  it("converts sink records into INTERNAL spans with allowlisted attributes and links", () => {
    const span = workflowSpanToServerSpan(record({
      attributes: { "space.workflow_type": "dotGoalWorkflow", prompt: PRIVATE[0] },
      links: [{ traceparent, type: "continue_as_new", runId: "run-1" }]
    }));
    expect(span).toMatchObject({ kind: 1, startTimeUnixNano: 1_000_000_000n, endTimeUnixNano: 1_500_000_000n, attributes: { "space.workflow_type": "dotGoalWorkflow" } });
    expect(span.links).toEqual([{ traceId: "a".repeat(32), spanId: "b".repeat(16), attributes: { "space.link_type": "continue_as_new", "space.run_id": "run-1" } }]);
  });
});
