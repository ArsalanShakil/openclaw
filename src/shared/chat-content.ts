/** Check whether a block type represents extractable text content. */
function isTextBlockType(type: unknown): boolean {
  return type === "text" || type === "output_text";
}

/**
 * Try to parse a string as a JSON-encoded content block array and extract text.
 * Returns the extracted text chunks, or null if the string is not a valid
 * content block array. This prevents serialized content arrays from leaking
 * through as raw JSON text (see openclaw/openclaw#29028).
 */
function tryParseStringifiedContentBlocks(
  raw: string,
  sanitizeText?: (text: string) => string,
): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  // Validate that every element looks like a content block with a type field.
  const chunks: string[] = [];
  let allBlocks = true;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || !("type" in item)) {
      allBlocks = false;
      break;
    }
    if (isTextBlockType((item as { type?: unknown }).type)) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") {
        const value = sanitizeText ? sanitizeText(text) : text;
        if (value.trim()) {
          chunks.push(value);
        }
      }
    }
  }
  if (!allBlocks) {
    return null;
  }
  return chunks;
}

export function extractTextFromChatContent(
  content: unknown,
  opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
  },
): string | null {
  const normalize = opts?.normalizeText ?? ((text: string) => text.replace(/\s+/g, " ").trim());
  const joinWith = opts?.joinWith ?? " ";

  if (typeof content === "string") {
    // Detect JSON-stringified content block arrays and extract their text
    // instead of returning the raw serialized form.
    const parsedChunks = tryParseStringifiedContentBlocks(content, opts?.sanitizeText);
    if (parsedChunks !== null && parsedChunks.length > 0) {
      const joined = normalize(parsedChunks.join(joinWith));
      return joined ? joined : null;
    }

    const value = opts?.sanitizeText ? opts.sanitizeText(content) : content;
    const normalized = normalize(value);
    return normalized ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (!isTextBlockType((block as { type?: unknown }).type)) {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      continue;
    }
    const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
    if (value.trim()) {
      chunks.push(value);
    }
  }

  const joined = normalize(chunks.join(joinWith));
  return joined ? joined : null;
}
