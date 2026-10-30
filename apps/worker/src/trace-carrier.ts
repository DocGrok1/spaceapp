/**
 * Trace context that travels between Temporal workflows and activities in a
 * Temporal header (never in workflow or activity arguments), and the span
 * attribute allowlist shared by workflow and activity spans.
 *
 * This module is pure: it is imported both by the workflow sandbox
 * (workflow-tracing.ts) and by the worker process. It performs no I/O, reads no
 * clock and uses no random source, so it is safe during workflow replay.
 */
import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { formatTraceparent, isSafeErrorCode, parseTraceparent, type ParsedTraceparent } from "@space/contracts";

/** Temporal header that carries {@link TraceCarrier}. */
export const SPACE_TRACE_HEADER = "space-trace";

export type TraceLinkType = "continue_as_new" | "background_continuation" | "parent_workflow";

export interface TraceLink {
  traceparent: string;
  type: TraceLinkType;
  /** Temporal run id of the run that is continued, when known. */
  runId?: string;
}

export interface TraceCarrier {
  /** W3C traceparent whose parent id is the span the receiver must be a child of. */
  traceparent: string | null;
  /** Links the receiver attaches to its span. */
  links?: TraceLink[];
}

const MAX_LINKS = 8;
const runIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const linkTypes: ReadonlySet<string> = new Set(["continue_as_new", "background_continuation", "parent_workflow"]);

type Headers = Record<string, Payload>;

/** Returns headers with the carrier set; other headers are kept. */
export function withTraceHeader(headers: Headers, carrier: TraceCarrier): Headers {
  return { ...headers, [SPACE_TRACE_HEADER]: defaultPayloadConverter.toPayload(carrier) };
}

/** Reads and validates the carrier; anything malformed is ignored (null). */
export function readTraceHeader(headers: Headers | undefined | null): TraceCarrier | null {
  const payload = headers?.[SPACE_TRACE_HEADER];
  if (!payload) return null;
  let value: unknown;
  try {
    value = defaultPayloadConverter.fromPayload(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { traceparent?: unknown; links?: unknown };
  const parent = parseTraceparent(record.traceparent);
  const links: TraceLink[] = [];
  if (Array.isArray(record.links)) {
    for (const raw of record.links.slice(0, MAX_LINKS)) {
      const link = raw as { traceparent?: unknown; type?: unknown; runId?: unknown } | null;
      const parsed = parseTraceparent(link?.traceparent);
      if (!parsed || typeof link?.type !== "string" || !linkTypes.has(link.type)) continue;
      links.push({
        traceparent: formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags),
        type: link.type as TraceLinkType,
        ...(typeof link.runId === "string" && runIdPattern.test(link.runId) ? { runId: link.runId } : {})
      });
    }
  }
  return {
    traceparent: parent ? formatTraceparent(parent.traceId, parent.parentId, parent.flags) : null,
    ...(links.length ? { links } : {})
  };
}

// ---------------------------------------------------------------------------
// Deterministic ids. Workflow span ids are derived from Temporal ids, so the
// same run always gets the same span id: a replayed or retried workflow task
// produces identical ids (and the worker drops the duplicate), and the
// workflow's seeded random source is never consumed, so existing histories
// replay unchanged.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(seed: string): bigint {
  let hash = FNV_OFFSET;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= BigInt(seed.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function hex64(seed: string): string {
  const value = fnv1a64(seed).toString(16).padStart(16, "0");
  // All-zero ids are invalid in W3C Trace Context.
  return /^0+$/.test(value) ? "0000000000000001" : value;
}

/** 16 lower-case hex characters derived from the seed. */
export function deterministicSpanId(seed: string): string {
  return hex64(`span:${seed}`);
}

/** 32 lower-case hex characters derived from the seed. */
export function deterministicTraceId(seed: string): string {
  return `${hex64(`trace-hi:${seed}`)}${hex64(`trace-lo:${seed}`)}`;
}

// ---------------------------------------------------------------------------
// Attribute allowlist. Only these keys are ever exported from the workers, and
// only with safe values: identifiers (no spaces, slashes or other characters
// that prompts, URLs, file paths or error messages contain), finite integers,
// and enumerated codes. Everything else is dropped.

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const typeNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,119}$/;

type AttributeKind = "id" | "type" | "count" | "code" | "enum";

export const SPAN_ATTRIBUTE_ALLOWLIST: Readonly<Record<string, AttributeKind>> = {
  "space.trace_id": "id",
  "space.parent_trace_id": "id",
  "space.workflow_id": "id",
  "space.run_id": "id",
  "space.parent_workflow_id": "id",
  "space.continued_from_run_id": "id",
  "space.room_id": "id",
  "space.pane_id": "id",
  "space.mission_id": "id",
  "space.agent_run_id": "id",
  "space.action_id": "id",
  "space.goal_id": "id",
  "space.activity_id": "id",
  "space.workflow_type": "type",
  "space.activity_type": "type",
  "space.attempt": "count",
  "space.duration_ms": "count",
  "space.queue_ms": "count",
  "space.continuation_generation": "count",
  "space.outcome": "enum",
  "space.reason_code": "code",
  "space.category": "code",
  "space.link_type": "enum"
};

const enumValues: Readonly<Record<string, ReadonlySet<string>>> = {
  "space.outcome": new Set(["COMPLETED", "FAILED_RESULT", "FAILED", "CANCELLED", "CONTINUED_AS_NEW"]),
  "space.link_type": linkTypes
};

function safeValue(key: string, kind: AttributeKind, value: unknown): string | number | null {
  switch (kind) {
    case "id":
      return typeof value === "string" && identifierPattern.test(value) ? value : null;
    case "type":
      return typeof value === "string" && typeNamePattern.test(value) ? value : null;
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    case "code":
      return isSafeErrorCode(value) ? value : null;
    case "enum":
      return typeof value === "string" && enumValues[key]?.has(value) ? value : null;
  }
}

/** Keeps allowlisted keys with safe values; drops everything else. */
export function allowlistSpanAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const kind = SPAN_ATTRIBUTE_ALLOWLIST[key];
    if (!kind || value === null || value === undefined) continue;
    const safe = safeValue(key, kind, value);
    if (safe !== null) result[key] = safe;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Correlation ids from workflow arguments (ids only; prompts and content are
// never read). Mirrors activityCorrelation in activity-observability.ts.

const correlationKeys = {
  traceId: "space.trace_id",
  requestId: "space.parent_trace_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  missionId: "space.mission_id",
  roomAgentMissionId: "space.mission_id",
  agentRunId: "space.agent_run_id",
  actionId: "space.action_id",
  goalId: "space.goal_id"
} as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

function collect(value: unknown, into: Record<string, unknown>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const [key, attribute] of Object.entries(correlationKeys)) {
    if (into[attribute] === undefined && typeof record[key] === "string" && identifierPattern.test(record[key] as string)) {
      into[attribute] = record[key];
    }
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) collect(record[key], into, depth - 1);
}

/** Allowlisted correlation attributes found in workflow or activity arguments. */
export function correlationAttributes(args: readonly unknown[]): Record<string, string | number> {
  const found: Record<string, unknown> = {};
  for (const arg of args) collect(arg, found, 2);
  if (found["space.parent_trace_id"] === found["space.trace_id"]) delete found["space.parent_trace_id"];
  return allowlistSpanAttributes(found);
}

function findTraceparent(value: unknown, depth: number): ParsedTraceparent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const own = parseTraceparent(record.traceparent);
  if (own) return own;
  if (depth <= 0) return null;
  for (const key of nestedKeys) {
    const nested = findTraceparent(record[key], depth - 1);
    if (nested) return nested;
  }
  return null;
}

/** The originating request's traceparent carried in arguments (for example DummyTurnInput.traceparent). */
export function traceparentFromArgs(args: readonly unknown[]): ParsedTraceparent | null {
  for (const arg of args) {
    const found = findTraceparent(arg, 2);
    if (found) return found;
  }
  return null;
}

/** The background continuation a turn continues, from roomAgentContinuation in its arguments. */
export function continuationFromArgs(args: readonly unknown[]): { traceparent: string | null; sourceRunId: string | null; generation: number | null } | null {
  for (const arg of args) {
    for (const candidate of [arg, (arg as { turn?: unknown } | null)?.turn]) {
      const continuation = (candidate as { roomAgentContinuation?: unknown } | null)?.roomAgentContinuation as
        { sourceTraceparent?: unknown; sourceRunId?: unknown; generation?: unknown } | undefined;
      if (!continuation || typeof continuation !== "object") continue;
      const parsed = parseTraceparent(continuation.sourceTraceparent);
      return {
        traceparent: parsed ? formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags) : null,
        sourceRunId: typeof continuation.sourceRunId === "string" && identifierPattern.test(continuation.sourceRunId) ? continuation.sourceRunId : null,
        generation: typeof continuation.generation === "number" && Number.isSafeInteger(continuation.generation) ? continuation.generation : null
      };
    }
  }
  return null;
}
