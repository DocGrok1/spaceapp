import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

const span = (overrides: Partial<ServerSpan> = {}): ServerSpan => ({
  traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null, name: "workflow example",
  startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: { "space.attempt": 1 }, error: false, kind: 1, ...overrides
});

describe("shared OTLP span exporter (worker additions)", () => {
  it("serializes span links and leaves spans without links unchanged", () => {
    const linked = otlpTraceRequest([span({ links: [{ traceId: "c".repeat(32), spanId: "d".repeat(16), attributes: { "space.link_type": "continue_as_new" } }] })], "space-worker");
    expect(linked.resourceSpans[0]!.scopeSpans[0]!.spans[0]).toMatchObject({
      links: [{ traceId: "c".repeat(32), spanId: "d".repeat(16), attributes: [{ key: "space.link_type", value: { stringValue: "continue_as_new" } }] }]
    });
    const plain = otlpTraceRequest([span()], "space-api").resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect("links" in plain).toBe(false);
  });

  it("drops invalid links but keeps the span", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({ endpoint: "http://collector.test", serviceName: "space-worker", flushIntervalMs: 60_000,
      fetch: async (_url, init) => { bodies.push(init.body); return { ok: true }; } });
    exporter.record(span({ links: [{ traceId: "not-hex", spanId: "d".repeat(16) }, { traceId: "c".repeat(32), spanId: "d".repeat(16) }] }));
    await exporter.close();
    const sent = JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans[0];
    expect(sent.links).toEqual([{ traceId: "c".repeat(32), spanId: "d".repeat(16), attributes: [] }]);
  });

  it("keeps exporting after a flush with an empty queue (idle timer tick)", async () => {
    let posts = 0;
    const exporter = createOtlpSpanExporter({ endpoint: "http://collector.test", serviceName: "space-worker", flushIntervalMs: 60_000,
      fetch: async () => { posts += 1; return { ok: true }; } });
    await exporter.flush(); // what the interval timer does while nothing was recorded
    exporter.record(span());
    await exporter.flush();
    exporter.record(span({ spanId: "e".repeat(16) }));
    await exporter.close();
    expect(posts).toBe(2);
    expect(exporter.stats()).toEqual({ exported: 2, dropped: 0, failed: 0 });
  });

  it("never blocks record() on a slow collector and counts drops beyond the bound", async () => {
    let release: () => void = () => {};
    const exporter = createOtlpSpanExporter({ endpoint: "http://collector.test", serviceName: "space-worker", flushIntervalMs: 60_000,
      batchSize: 1, maxQueue: 2, timeoutMs: 50,
      fetch: (_url, init) => new Promise((resolve, reject) => {
        release = () => resolve({ ok: true });
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }) });
    const started = Date.now();
    for (let index = 0; index < 10; index += 1) exporter.record(span({ spanId: index.toString(16).padStart(16, "1") }));
    expect(Date.now() - started).toBeLessThan(50);
    expect(exporter.stats().dropped).toBeGreaterThan(0);
    await exporter.close();
    release();
    const stats = exporter.stats();
    expect(stats.exported + stats.failed + stats.dropped).toBe(10);
  });
});
