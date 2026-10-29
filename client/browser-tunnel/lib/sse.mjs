// The string API remains useful for callers with a complete SSE body.
export function parseSseJson(text) {
  return [...new JsonSseParser().push(text, true)];
}

// Decode bytes incrementally: a UTF-8 character or CRLF may cross any chunk.
export async function* readSseJson(body) {
  if (!body) throw new Error("MCP SSE response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new JsonSseParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        yield* parser.push(decoder.decode(), true);
        return;
      }
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Also runs when a consumer stops at its final response or delivery fails.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class JsonSseParser {
  constructor() {
    this.line = "";
    this.dataLines = [];
    this.skipLf = false;
    this.firstCharacter = true;
  }

  *push(text, final = false) {
    for (const character of text) {
      if (this.firstCharacter) {
        this.firstCharacter = false;
        if (character === "\uFEFF") continue;
      }
      if (this.skipLf) {
        this.skipLf = false;
        if (character === "\n") continue;
      }
      if (character === "\r" || character === "\n") {
        this.skipLf = character === "\r";
        const event = this.acceptLine();
        if (event !== undefined) yield event;
      } else {
        this.line += character;
      }
    }

    if (final) {
      if (this.line) this.acceptLine();
      const event = this.flush();
      if (event !== undefined) yield event;
    }
  }

  acceptLine() {
    const line = this.line;
    this.line = "";
    if (!line) return this.flush();
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
  }

  flush() {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    // Empty data can be an SSE priming/keepalive event rather than JSON.
    if (!data.trim()) return;
    return JSON.parse(data);
  }
}
