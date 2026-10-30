/**
 * Workflow-side OTLP tracing (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT). Registered as
 * a Temporal workflow interceptor module only when export is enabled
 * (worker-tracing.ts).
 *
 * Determinism: this code runs inside the workflow sandbox and does no I/O. Span
 * ids are derived from Temporal ids (never from the workflow's seeded random
 * source), times come from the workflow clock, and finished spans leave the
 * sandbox only through the `spaceTracing` sink, which the worker registers with
 * `callDuringReplay: false`. Replaying a history therefore emits nothing, and
 * the trace context travels in Temporal headers, which are not part of the
 * command sequence that replay checks.
 *
 * Tree: the API SERVER span (traceparent from the parent header, the workflow
 * input or the memo) -> workflow span -> one span per activity attempt (emitted
 * by the activity interceptor) and child workflow spans. Continue-as-new runs
 * and background continuations carry an OTLP span link to what they continue.
 */
import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, isSafeErrorCode, parseTraceparent, type ParsedTraceparent } from "@space/contracts";
import {
  allowlistSpanAttributes,
  continuationFromArgs,
  correlationAttributes,
  deterministicSpanId,
  deterministicTraceId,
  readTraceHeader,
  traceparentFromArgs,
  withTraceHeader,
  type TraceCarrier,
  type TraceLink
} from "./trace-carrier.js";

export type WorkflowSpanOutcome = "COMPLETED" | "FAILED_RESULT" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";

/** A finished workflow (or workflow scope) span, as handed to the sink. */
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  error: boolean;
  attributes: Record<string, string | number>;
  links: TraceLink[];
}

export interface SpaceTracingSinks extends Sinks {
  spaceTracing: { recordSpan(span: WorkflowSpanRecord): void };
}

interface TraceScope {
  traceId: string;
  spanId: string;
  flags: string;
}

interface WorkflowTraceState {
  run: TraceScope | null;
  /** The run's own parent, carried to a continue-as-new run. */
  runParent: ParsedTraceparent | null;
  current: TraceScope | null;
  scopes: number;
}

// Kept on the workflow's global object: Temporal isolates globals per workflow
// execution, also when V8 contexts are reused.
const STATE_KEY = "__spaceWorkflowTraceState";

function traceState(): WorkflowTraceState | null {
  return ((globalThis as Record<string, unknown>)[STATE_KEY] as WorkflowTraceState | undefined) ?? null;
}

function scopeTraceparent(scope: TraceScope): string {
  return formatTraceparent(scope.traceId, scope.spanId, scope.flags);
}

function failureCode(error: unknown): string | null {
  let failure = error as { type?: unknown; name?: unknown; cause?: unknown } | null | undefined;
  let code: string | null = null;
  for (let depth = 0; failure && depth < 8; depth += 1, failure = failure.cause as typeof failure) {
    if (isSafeErrorCode(failure.type)) code = failure.type;
    else if (!code && failure.name === "TimeoutFailure") code = "WORKFLOW_ACTIVITY_TIMEOUT";
  }
  return code;
}

function outcomeOf(error: unknown): WorkflowSpanOutcome {
  if (error instanceof ContinueAsNew) return "CONTINUED_AS_NEW";
  return isCancellation(error) ? "CANCELLED" : "FAILED";
}

function resultOutcome(result: unknown): WorkflowSpanOutcome {
  const status = (result as { status?: unknown } | null)?.status;
  if (status === "FAILED") return "FAILED_RESULT";
  return "COMPLETED";
}

function dedupeLinks(links: TraceLink[]): TraceLink[] {
  const seen = new Set<string>();
  return links.filter((link) => !seen.has(link.traceparent) && Boolean(seen.add(link.traceparent))).slice(0, 8);
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  const sinks = proxySinks<SpaceTracingSinks>();
  const state: WorkflowTraceState = { run: null, runParent: null, current: null, scopes: 0 };
  (globalThis as Record<string, unknown>)[STATE_KEY] = state;

  const carrierForChild = (args: readonly unknown[]): TraceCarrier => {
    const scope = state.current!;
    const own = traceparentFromArgs(args);
    // A turn queued by a later API request carries that request's context;
    // parent it there and link it to the workflow that started it.
    if (own && own.traceId !== scope.traceId) {
      return {
        traceparent: formatTraceparent(own.traceId, own.parentId, own.flags),
        links: [{ traceparent: scopeTraceparent(scope), type: "parent_workflow", runId: workflowInfo().runId }]
      };
    }
    return { traceparent: scopeTraceparent(scope) };
  };

  return {
    inbound: [{
      async execute(input, next) {
        const info = workflowInfo();
        const header = readTraceHeader(input.headers);
        const parent = header
          ? parseTraceparent(header.traceparent)
          : traceparentFromArgs(input.args) ?? parseTraceparent(info.memo?.traceparent);
        const continuation = continuationFromArgs(input.args);
        const links = dedupeLinks([
          ...(header?.links ?? []),
          ...(continuation?.traceparent ? [{
            traceparent: continuation.traceparent,
            type: "background_continuation" as const
          }] : [])
        ]);
        const run: TraceScope = {
          traceId: parent?.traceId ?? deterministicTraceId(`${info.workflowId}/${info.runId}`),
          spanId: deterministicSpanId(`workflow/${info.runId}`),
          flags: parent?.flags ?? "01"
        };
        state.run = run;
        state.runParent = parent;
        state.current = run;
        const startTimeMs = info.runStartTime.getTime();
        let outcome: WorkflowSpanOutcome = "COMPLETED";
        let reasonCode: string | null = null;
        try {
          const result = await next(input);
          outcome = resultOutcome(result);
          return result;
        } catch (error) {
          outcome = outcomeOf(error);
          if (outcome === "FAILED") reasonCode = failureCode(error) ?? "WORKFLOW_FAILED";
          throw error;
        } finally {
          const continuedFrom = links.find((link) => link.type === "continue_as_new")?.runId;
          sinks.spaceTracing.recordSpan({
            traceId: run.traceId,
            spanId: run.spanId,
            parentSpanId: parent?.parentId ?? null,
            name: `workflow ${info.workflowType}`,
            startTimeMs,
            endTimeMs: Math.max(startTimeMs, Date.now()),
            error: outcome === "FAILED" || outcome === "FAILED_RESULT",
            attributes: allowlistSpanAttributes({
              ...correlationAttributes(input.args),
              "space.workflow_type": info.workflowType,
              "space.workflow_id": info.workflowId,
              "space.run_id": info.runId,
              "space.parent_workflow_id": info.parent?.workflowId,
              "space.continued_from_run_id": continuedFrom,
              "space.continuation_generation": continuation?.generation ?? undefined,
              "space.attempt": info.attempt,
              "space.outcome": outcome,
              "space.reason_code": reasonCode,
              "space.duration_ms": Math.max(0, Date.now() - startTimeMs)
            }),
            links
          });
        }
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        return next(state.current ? { ...input, headers: withTraceHeader(input.headers, { traceparent: scopeTraceparent(state.current) }) } : input);
      },
      scheduleLocalActivity(input, next) {
        return next(state.current ? { ...input, headers: withTraceHeader(input.headers, { traceparent: scopeTraceparent(state.current) }) } : input);
      },
      startChildWorkflowExecution(input, next) {
        return next(state.current ? { ...input, headers: withTraceHeader(input.headers, carrierForChild(input.options.args ?? [])) } : input);
      },
      continueAsNew(input, next) {
        if (!state.run) return next(input);
        // The next run stays under this run's parent (same trace) and links to this run.
        return next({ ...input, headers: withTraceHeader(input.headers, {
          traceparent: state.runParent ? formatTraceparent(state.runParent.traceId, state.runParent.parentId, state.runParent.flags) : null,
          links: [{ traceparent: scopeTraceparent(state.run), type: "continue_as_new", runId: workflowInfo().runId }]
        }) });
      }
    }]
  };
};

export interface WorkflowScopeOrigin {
  /** Span name suffix, for example "mission". */
  name: string;
  /** The originating request's traceparent; the scope starts a new trace without one. */
  traceparent?: string | null;
  /** Arguments to read allowlisted correlation ids and continuation links from. */
  args: readonly unknown[];
}

/**
 * Runs `execute` in its own span inside a long-lived workflow (one Room Agent
 * supervisor mission turn), so the turn's activities and child workflow join
 * the trace of the API request that queued it instead of the supervisor run.
 * The scope span links to the supervisor run. Without tracing installed this
 * only calls `execute`.
 */
export async function traceWorkflowScope<T>(origin: WorkflowScopeOrigin, execute: () => Promise<T>): Promise<T> {
  const state = traceState();
  if (!state?.run) return execute();
  const info = workflowInfo();
  const index = state.scopes++;
  const parent = parseTraceparent(origin.traceparent);
  const continuation = continuationFromArgs(origin.args);
  const scope: TraceScope = {
    traceId: parent?.traceId ?? deterministicTraceId(`${info.workflowId}/${info.runId}/scope/${index}`),
    spanId: deterministicSpanId(`workflow/${info.runId}/scope/${index}`),
    flags: parent?.flags ?? state.run.flags
  };
  const links = dedupeLinks([
    { traceparent: scopeTraceparent(state.run), type: "parent_workflow", runId: info.runId },
    ...(continuation?.traceparent ? [{ traceparent: continuation.traceparent, type: "background_continuation" as const }] : [])
  ]);
  const sinks = proxySinks<SpaceTracingSinks>();
  const previous = state.current;
  state.current = scope;
  const startTimeMs = Date.now();
  let outcome: WorkflowSpanOutcome = "COMPLETED";
  let reasonCode: string | null = null;
  try {
    const result = await execute();
    outcome = resultOutcome(result);
    return result;
  } catch (error) {
    outcome = outcomeOf(error);
    if (outcome === "FAILED") reasonCode = failureCode(error) ?? "WORKFLOW_FAILED";
    throw error;
  } finally {
    state.current = previous;
    sinks.spaceTracing.recordSpan({
      traceId: scope.traceId,
      spanId: scope.spanId,
      parentSpanId: parent?.parentId ?? null,
      name: `workflow ${info.workflowType} ${origin.name}`,
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, Date.now()),
      error: outcome === "FAILED" || outcome === "FAILED_RESULT",
      attributes: allowlistSpanAttributes({
        ...correlationAttributes(origin.args),
        "space.workflow_type": info.workflowType,
        "space.workflow_id": info.workflowId,
        "space.run_id": info.runId,
        "space.continuation_generation": continuation?.generation ?? undefined,
        "space.outcome": outcome,
        "space.reason_code": reasonCode,
        "space.duration_ms": Math.max(0, Date.now() - startTimeMs)
      }),
      links
    });
  }
}
