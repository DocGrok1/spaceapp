import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import { parseTraceparent } from "@space/contracts";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { allowlistSpanAttributes } from "./trace-carrier.js";
import type { SpaceTracingSinks, WorkflowSpanRecord } from "./workflow-tracing.js";

/**
 * Worker-process half of the OTLP tracing (see workflow-tracing.ts). One call
 * gives every Temporal worker entrypoint the same interceptors and sinks:
 * with `SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` unset (`spans` null) only the
 * existing activity observability interceptor is installed and no workflow
 * interceptor or sink is registered.
 */

/** The workflow interceptor module; the TypeScript source when there is no build (tests). */
export function workflowTracingModulePath(): string {
  const built = fileURLToPath(new URL("./workflow-tracing.js", import.meta.url));
  if (existsSync(built)) return built;
  return built.replace(/\.js$/, ".ts");
}

/** Converts a sink record into an exporter span, keeping only allowlisted attributes. */
export function workflowSpanToServerSpan(record: WorkflowSpanRecord): ServerSpan {
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: record.name,
    startTimeUnixNano: BigInt(Math.trunc(record.startTimeMs)) * 1_000_000n,
    endTimeUnixNano: BigInt(Math.trunc(Math.max(record.startTimeMs, record.endTimeMs))) * 1_000_000n,
    attributes: allowlistSpanAttributes(record.attributes),
    error: record.error,
    kind: 1,
    links: record.links.flatMap((link) => {
      const parsed = parseTraceparent(link.traceparent);
      return parsed ? [{
        traceId: parsed.traceId,
        spanId: parsed.parentId,
        attributes: allowlistSpanAttributes({ "space.link_type": link.type, "space.run_id": link.runId })
      }] : [];
    })
  };
}

/**
 * Sinks for the workflow spans. `callDuringReplay: false`: replaying a history
 * never emits a span. A failed or timed-out workflow task can call a sink again
 * when the task is retried; span ids are deterministic, so the repeat is
 * dropped here. Recording never throws into the workflow.
 */
export function createWorkflowTracingSinks(spans: SpanExporter, recentLimit = 4096): InjectedSinks<SpaceTracingSinks> {
  const recent = new Set<string>();
  return {
    spaceTracing: {
      recordSpan: {
        fn(_info, record) {
          try {
            const key = `${record.traceId}:${record.spanId}`;
            if (recent.has(key)) return;
            recent.add(key);
            if (recent.size > recentLimit) recent.delete(recent.values().next().value!);
            spans.record(workflowSpanToServerSpan(record));
          } catch {
            // Tracing is best effort and must never affect workflow work.
          }
        },
        callDuringReplay: false
      }
    }
  };
}

/** Interceptors and sinks for Worker.create, the same for all three worker processes. */
export function workerTracingOptions(spans: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const activity = [createActivityObservabilityInterceptors({ spans })];
  if (!spans) return { interceptors: { activity } };
  return {
    interceptors: { activity, workflowModules: [workflowTracingModulePath()] },
    sinks: createWorkflowTracingSinks(spans)
  };
}
