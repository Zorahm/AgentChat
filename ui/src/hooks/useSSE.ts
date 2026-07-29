/** SSE event types and reader using fetch (supports POST). */

export interface SSEEvent {
  event: string;
  data: string;
}

export interface SSEReader {
  close: () => void;
}

export interface SSEOptions {
  /** Event names that legitimately end the stream. When given, a connection
   *  that closes without one of them is reported through `onError` instead of
   *  ending silently — see SSE_CLOSED_EARLY. */
  terminalEvents?: readonly string[];
}

/** `Error.name` of the failure raised when the response body ended before any
 *  terminal event arrived — a backend restart, a crashed sidecar, or a phone
 *  losing the LAN/Tailscale link mid-reply. It has to be reported: the caller
 *  tears the stream down in its error path, and a stream that is never torn
 *  down leaves its chat marked "streaming" forever, with the composer disabled.
 *  Named so callers can show a translated message instead of this marker. */
export const SSE_CLOSED_EARLY = "SseClosedEarly";

async function* sseGenerator(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  // Per the SSE spec a record may carry several `data:` lines, which are joined
  // with "\n". Overwriting instead of appending silently truncated any such
  // event to its last line; today the backend always emits one line, but that
  // is a property of json.dumps, not a guarantee this parser should rely on.
  let dataLines: string[] = [];

  const dispatch = (): SSEEvent | null => {
    if (dataLines.length === 0) return null;
    const out: SSEEvent = { event: currentEvent, data: dataLines.join("\n") };
    currentEvent = "";
    dataLines = [];
    return out;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        // Tolerate CRLF: a proxy that rewrites line endings would otherwise
        // leave a "\r" here, so no line ever compares equal to "" and not a
        // single event is ever dispatched.
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          const event = dispatch();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        // "field: value" — one optional leading space is part of the framing.
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") currentEvent = value2;
        else if (field === "data") dataLines.push(value2);
      }
    }
    // A stream that ends without its final blank line still has one record's
    // worth of data buffered — emit it rather than dropping the last event.
    const tail = dispatch();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function sseConnect(
  url: string,
  body: unknown,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
  options: SSEOptions = {},
): SSEReader {
  const controller = new AbortController();
  const terminalEvents = options.terminalEvents ?? [];

  (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        onError(new Error(text || `HTTP ${response.status}`));
        return;
      }

      let sawTerminal = false;
      for await (const event of sseGenerator(response)) {
        if (terminalEvents.includes(event.event)) sawTerminal = true;
        onEvent(event);
      }
      // The body ran out without the backend saying it was finished. Nothing
      // threw — the reader simply reached the end — so this is the only place
      // that can tell the caller its stream is over. Reached after an abort
      // only in theory: aborting rejects the read and lands in `catch` below.
      if (terminalEvents.length > 0 && !sawTerminal) {
        const closed = new Error(SSE_CLOSED_EARLY);
        closed.name = SSE_CLOSED_EARLY;
        onError(closed);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    close: () => controller.abort(),
  };
}
