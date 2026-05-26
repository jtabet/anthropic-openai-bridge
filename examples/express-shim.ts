/**
 * Example: add a `/v1/messages` endpoint to an Express app that already
 * forwards to an OpenAI-compatible upstream.
 *
 * This file is illustrative — it is not part of the npm package. Run it
 * with `tsx examples/express-shim.ts` or adapt the snippet into your
 * existing app.
 */

import {
  AnthropicStreamEncoder,
  MalformedInputError,
  UnsupportedFeatureError,
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
} from "@jtabet/anthropic-openai-bridge";
import express, { type Request, type Response } from "express";

const UPSTREAM = process.env.OPENAI_UPSTREAM ?? "http://localhost:8000/v1";
const UPSTREAM_KEY = process.env.OPENAI_UPSTREAM_KEY ?? "";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/v1/messages", async (req: Request, res: Response) => {
  let openaiReq: ReturnType<typeof anthropicToOpenAIRequest>;
  try {
    openaiReq = anthropicToOpenAIRequest(req.body);
  } catch (err) {
    if (err instanceof MalformedInputError) {
      return res
        .status(400)
        .json({ type: "error", error: { type: "invalid_request_error", message: err.message } });
    }
    if (err instanceof UnsupportedFeatureError) {
      return res
        .status(400)
        .json({ type: "error", error: { type: "invalid_request_error", message: err.message } });
    }
    throw err;
  }

  const upstreamResp = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${UPSTREAM_KEY}`,
    },
    body: JSON.stringify(openaiReq),
  });

  if (openaiReq.stream) {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    const enc = new AnthropicStreamEncoder({ modelOverride: req.body.model });
    const reader = upstreamResp.body?.getReader();
    if (!reader) return res.end();

    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // OpenAI SSE: lines like `data: {...}\n\n`
      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice("data: ".length);
        if (payload === "[DONE]") continue;
        const chunk = JSON.parse(payload);
        for (const out of enc.feed(chunk)) res.write(out);
      }
    }
    for (const out of enc.end()) res.write(out);
    res.end();
    return;
  }

  const openaiJson = await upstreamResp.json();
  const anthropicMsg = openAIToAnthropicResponse(openaiJson);
  res.json(anthropicMsg);
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`anthropic-openai-bridge example on http://localhost:${PORT}`);
  console.log(`  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude "your prompt"`);
});
