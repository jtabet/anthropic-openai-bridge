/**
 * Example: same `/v1/messages` shim, native Bun.
 *
 * Run with: `bun examples/bun-serve-shim.ts`
 */

import {
  AnthropicStreamEncoder,
  anthropicToOpenAIRequest,
  MalformedInputError,
  openAIToAnthropicResponse,
  UnsupportedFeatureError,
} from "@jtabet/anthropic-openai-bridge";

const UPSTREAM = process.env.OPENAI_UPSTREAM ?? "http://localhost:8000/v1";
const UPSTREAM_KEY = process.env.OPENAI_UPSTREAM_KEY ?? "";
const PORT = Number(process.env.PORT ?? 8787);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/messages" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const body = await req.json();
    let openaiReq: ReturnType<typeof anthropicToOpenAIRequest>;
    try {
      openaiReq = anthropicToOpenAIRequest(body);
    } catch (err) {
      if (err instanceof MalformedInputError || err instanceof UnsupportedFeatureError) {
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: err.message } },
          { status: 400 },
        );
      }
      throw err;
    }

    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${UPSTREAM_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!openaiReq.stream) {
      const json = await upstream.json();
      return Response.json(openAIToAnthropicResponse(json));
    }

    const enc = new AnthropicStreamEncoder({ modelOverride: body.model });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const payload = line.slice("data: ".length);
            if (payload === "[DONE]") continue;
            const chunk = JSON.parse(payload);
            for (const out of enc.feed(chunk)) controller.enqueue(encoder.encode(out));
          }
        }
        for (const out of enc.end()) controller.enqueue(encoder.encode(out));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
});

console.log(`anthropic-openai-bridge example on http://localhost:${PORT}`);
console.log(`  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude "your prompt"`);
