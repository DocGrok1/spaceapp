import { describe, expect, it } from "vitest";
import { parseTraceparent } from "@space/contracts";
import { createRequestTraceContext, requestTraceContexts, traceparentForTraceId, TraceContextRegistry } from "../src/trace-context.js";
import { scheduleMemoryMutation } from "../src/memory-mutation-coordinator.js";
import { scheduleMemoryConsolidation } from "../src/memory-consolidation-coordinator.js";

describe("trace context handed to Temporal workflows", () => {
  it("names the request's exported SERVER span as the workflow's parent", () => {
    const registry = new TraceContextRegistry();
    const context = createRequestTraceContext(undefined);
    registry.remember("req:parent-span-01", context);
    const traceparent = traceparentForTraceId("req:parent-span-01", registry);
    expect(parseTraceparent(traceparent)).toEqual({ traceId: context.w3cTraceId, parentId: context.spanId, flags: "01" });
    expect(traceparentForTraceId("req:unknown-000001", registry)).toBeNull();
  });

  it("adds the correlation memo to memory workflows started during a traced request", async () => {
    const context = createRequestTraceContext(undefined);
    requestTraceContexts.remember("req:memory-start-01", context);
    const options: unknown[] = [];
    const start = async (_type: string, option: { workflowId: string }) => { options.push(option); return { workflowId: option.workflowId, firstExecutionRunId: "run:1" }; };
    await scheduleMemoryMutation({ changeSetId: "memory_change:traced", traceId: "req:memory-start-01" }, start as never);
    await scheduleMemoryConsolidation({ runId: "memory_run:traced", traceId: "req:memory-start-01" }, "space-memory-consolidation:traced", start as never);
    for (const option of options) {
      expect((option as { memo: Record<string, string> }).memo).toEqual({
        spaceTraceId: "req:memory-start-01", traceparent: context.traceparent, w3cTraceId: context.w3cTraceId
      });
    }
    expect(options).toHaveLength(2);
  });
});
