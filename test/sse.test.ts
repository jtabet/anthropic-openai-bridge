import { describe, expect, it } from "vitest";
import { frameEvent } from "../src/sse.js";

describe("frameEvent", () => {
  it("frames a simple event with event: and data: lines and trailing blank line", () => {
    const out = frameEvent({ type: "message_stop" });
    expect(out).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });

  it("preserves JSON of complex events", () => {
    const out = frameEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    expect(out.startsWith("event: content_block_delta\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const dataLine = out.split("\n")[1] ?? "";
    expect(dataLine.startsWith("data: ")).toBe(true);
    const json = JSON.parse(dataLine.slice("data: ".length));
    expect(json).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
  });

  it("escapes special characters within the JSON data line", () => {
    const out = frameEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: 'line1\nline2"with quote' },
    });
    // The newline inside text must be JSON-escaped to "\n" so the SSE framing
    // (which uses real \n as line terminators) is unambiguous.
    expect(out).toContain("line1\\nline2");
    expect(out).toContain('\\"with quote');
    // And the framing newlines are still real \n.
    expect(out.split("\n\n").length).toBe(2);
  });
});
