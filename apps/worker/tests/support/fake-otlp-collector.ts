// A local OTLP/HTTP JSON collector for tests: records every span posted to
// /v1/traces. No Docker, no network beyond loopback.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CollectedSpan {
  service: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: number;
  attributes: Record<string, string | number>;
  links: Array<{ traceId: string; spanId: string; attributes: Record<string, string | number> }>;
}

type OtlpAttribute = { key: string; value: { stringValue?: string; intValue?: string } };

function attributes(list: OtlpAttribute[] | undefined): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const { key, value } of list ?? []) result[key] = value.intValue !== undefined ? Number(value.intValue) : value.stringValue ?? "";
  return result;
}

export interface FakeOtlpCollector {
  endpoint: string;
  spans: CollectedSpan[];
  requests: number;
  close(): Promise<void>;
}

export async function startFakeOtlpCollector(options: { hang?: boolean } = {}): Promise<FakeOtlpCollector> {
  const collector: FakeOtlpCollector = { endpoint: "", spans: [], requests: 0, close: async () => {} };
  const server: Server = createServer((request, response) => {
    collector.requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (options.hang) return; // never answers: the exporter must time out
      if (request.method !== "POST" || request.url !== "/v1/traces") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const resourceSpans of body.resourceSpans ?? []) {
        const service = attributes(resourceSpans.resource?.attributes)["service.name"] as string;
        for (const scope of resourceSpans.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            collector.spans.push({
              service,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? null,
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              status: span.status?.code ?? 0,
              attributes: attributes(span.attributes),
              links: (span.links ?? []).map((link: { traceId: string; spanId: string; attributes?: OtlpAttribute[] }) => ({
                traceId: link.traceId, spanId: link.spanId, attributes: attributes(link.attributes)
              }))
            });
          }
        }
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  collector.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  collector.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return collector;
}
