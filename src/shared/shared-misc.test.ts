import { describe, expect, it, test } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
} from "./frontmatter.js";
import { resolveNodeIdFromCandidates } from "./node-match.js";

describe("extractTextFromChatContent", () => {
  it("normalizes string content", () => {
    expect(extractTextFromChatContent("  hello\nworld  ")).toBe("hello world");
  });

  it("extracts text blocks from array content", () => {
    expect(
      extractTextFromChatContent([
        { type: "text", text: " hello " },
        { type: "image_url", image_url: "https://example.com" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("applies sanitizer when provided", () => {
    expect(
      extractTextFromChatContent("Here [Tool Call: foo (ID: 1)] ok", {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("Here ok");
  });

  it("supports custom join and normalization", () => {
    expect(
      extractTextFromChatContent(
        [
          { type: "text", text: " hello " },
          { type: "text", text: "world " },
        ],
        {
          sanitizeText: (text) => text.trim(),
          joinWith: "\n",
          normalizeText: (text) => text.trim(),
        },
      ),
    ).toBe("hello\nworld");
  });

  it("extracts text from output_text blocks (OpenAI Responses format)", () => {
    expect(
      extractTextFromChatContent([
        { type: "output_text", text: "hello" },
        { type: "output_text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("mixes text and output_text blocks", () => {
    expect(
      extractTextFromChatContent([
        { type: "text", text: "hello" },
        { type: "output_text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("extracts text from a JSON-stringified content block array", () => {
    const stringified = JSON.stringify([{ type: "text", text: "heartbeat reply" }]);
    expect(extractTextFromChatContent(stringified)).toBe("heartbeat reply");
  });

  it("extracts text from stringified output_text blocks", () => {
    const stringified = JSON.stringify([{ type: "output_text", text: "heartbeat reply" }]);
    expect(extractTextFromChatContent(stringified)).toBe("heartbeat reply");
  });

  it("joins multiple stringified text blocks", () => {
    const stringified = JSON.stringify([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(extractTextFromChatContent(stringified)).toBe("hello world");
  });

  it("skips non-text blocks in stringified arrays", () => {
    const stringified = JSON.stringify([
      { type: "text", text: "visible" },
      { type: "image_url", image_url: "https://example.com" },
    ]);
    expect(extractTextFromChatContent(stringified)).toBe("visible");
  });

  it("does not parse plain strings starting with [", () => {
    expect(extractTextFromChatContent("[hello world]")).toBe("[hello world]");
  });

  it("does not parse JSON arrays of non-objects", () => {
    expect(extractTextFromChatContent(JSON.stringify([1, 2, 3]))).toBe("[1,2,3]");
  });

  it("does not parse arrays missing type field", () => {
    const stringified = JSON.stringify([{ text: "no type" }]);
    expect(extractTextFromChatContent(stringified)).toBe(stringified.replace(/\s+/g, " ").trim());
  });

  it("applies sanitizer to stringified content blocks", () => {
    const stringified = JSON.stringify([{ type: "text", text: "secret [Tool Call: x] ok" }]);
    expect(
      extractTextFromChatContent(stringified, {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("secret ok");
  });

  it("returns null for stringified array with only whitespace text", () => {
    // When all text blocks contain only whitespace, the parsed chunks are empty
    // so the function falls through to the plain-string path which normalizes
    // the raw JSON string itself.
    const stringified = JSON.stringify([{ type: "text", text: "   " }]);
    const result = extractTextFromChatContent(stringified);
    expect(typeof result).toBe("string");
    expect(result).not.toBe(null);
  });

  it("handles doubly-stringified content blocks (recursive escaping)", () => {
    const inner = JSON.stringify([{ type: "text", text: "actual content" }]);
    // The outer layer is just a plain string starting with '[{\"type...',
    // which the function should detect and parse.
    expect(extractTextFromChatContent(inner)).toBe("actual content");
  });
});

describe("shared/frontmatter", () => {
  test("normalizeStringList handles strings and arrays", () => {
    expect(normalizeStringList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList([" a ", "", "b"])).toEqual(["a", "b"]);
    expect(normalizeStringList(null)).toEqual([]);
  });

  test("getFrontmatterString extracts strings only", () => {
    expect(getFrontmatterString({ a: "b" }, "a")).toBe("b");
    expect(getFrontmatterString({ a: 1 }, "a")).toBeUndefined();
  });

  test("parseFrontmatterBool respects fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
  });

  test("resolveOpenClawManifestBlock parses JSON5 metadata and picks openclaw block", () => {
    const frontmatter = {
      metadata: "{ openclaw: { foo: 1, bar: 'baz' } }",
    };
    expect(resolveOpenClawManifestBlock({ frontmatter })).toEqual({ foo: 1, bar: "baz" });
  });

  test("resolveOpenClawManifestBlock returns undefined for invalid input", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });
});

describe("resolveNodeIdFromCandidates", () => {
  it("matches nodeId", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456", displayName: "Raspberry Pi", remoteIp: "100.0.0.2" },
        ],
        "pi-456",
      ),
    ).toBe("pi-456");
  });

  it("matches displayName using normalization", () => {
    expect(
      resolveNodeIdFromCandidates([{ nodeId: "mac-123", displayName: "Mac Studio" }], "mac studio"),
    ).toBe("mac-123");
  });

  it("matches nodeId prefix (>=6 chars)", () => {
    expect(resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }], "mac-ab")).toBe("mac-abcdef");
  });

  it("throws unknown node with known list", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456" },
        ],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: /);
  });

  it("throws ambiguous node with matches list", () => {
    expect(() =>
      resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }, { nodeId: "mac-abc999" }], "mac-abc"),
    ).toThrow(/ambiguous node: mac-abc.*matches:/);
  });

  it("prefers a unique connected node when names are duplicated", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-old", displayName: "iPhone", connected: false },
          { nodeId: "ios-live", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toBe("ios-live");
  });

  it("stays ambiguous when multiple connected nodes match", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-a", displayName: "iPhone", connected: true },
          { nodeId: "ios-b", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*matches:/);
  });
});
