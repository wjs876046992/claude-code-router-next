import { describe, it, expect } from "vitest";
import {
  extractMessageText,
  shouldMergeSystemMessages,
  normalizeSystemMessagesForOpenAI,
} from "../api/routes";

describe("shouldMergeSystemMessages", () => {
  it("returns true for Qwen models (case-insensitive)", () => {
    expect(shouldMergeSystemMessages({}, "qwen3.6")).toBe(true);
    expect(shouldMergeSystemMessages({}, "Qwen/Qwen2.5-72B-Instruct")).toBe(true);
    expect(shouldMergeSystemMessages({}, "qwen-plus")).toBe(true);
  });

  it("returns true when provider has mergeSystemMessages: true", () => {
    expect(shouldMergeSystemMessages({ mergeSystemMessages: true }, "deepseek-v3")).toBe(true);
    expect(shouldMergeSystemMessages({ mergeSystemMessages: true }, "custom-model")).toBe(true);
  });

  it("returns false for non-Qwen models by default", () => {
    expect(shouldMergeSystemMessages({}, "deepseek-chat")).toBe(false);
    expect(shouldMergeSystemMessages({}, "gpt-4o")).toBe(false);
    expect(shouldMergeSystemMessages({}, "glm-4")).toBe(false);
    expect(shouldMergeSystemMessages({}, undefined)).toBe(false);
  });
});

describe("extractMessageText", () => {
  it("returns plain string as-is", () => {
    expect(extractMessageText("hello")).toBe("hello");
  });

  it("extracts text from array of text blocks", () => {
    const blocks = [
      { type: "text", text: "block 1" },
      { type: "text", text: "block 2" },
    ];
    expect(extractMessageText(blocks)).toBe("block 1\n\nblock 2");
  });

  it("extracts text from mixed strings and objects in array", () => {
    const blocks = ["text 1", { type: "text", text: "text 2" }];
    expect(extractMessageText(blocks)).toBe("text 1\n\ntext 2");
  });

  it("returns empty string for null/undefined or empty array", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText([])).toBe("");
  });
});

describe("normalizeSystemMessagesForOpenAI (default: mergeMultiple = false)", () => {
  it("keeps multiple distinct system messages separate at the front", () => {
    const messages = [
      { role: "system", content: "System 1" },
      { role: "user", content: "Hello" },
      { role: "system", content: "System 2" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, false);
    // Preserves original behavior: hoists system messages to the front without merging
    expect(result).toEqual([
      { role: "system", content: "System 1" },
      { role: "system", content: "System 2" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("deduplicates exact repeated system messages", () => {
    const messages = [
      { role: "system", content: "System reminder A" },
      { role: "user", content: "User 1" },
      { role: "system", content: "System reminder A" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, false);
    expect(result).toEqual([
      { role: "system", content: "System reminder A" },
      { role: "user", content: "User 1" },
    ]);
  });
});

describe("normalizeSystemMessagesForOpenAI (Qwen / strict: mergeMultiple = true)", () => {
  it("leaves single string system message at index 0 unchanged", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);
    expect(result).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("hoists a mid-conversation system message to index 0", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "system", content: "Always use tools." },
      { role: "user", content: "Help me" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);
    expect(result[0]).toEqual({
      role: "system",
      content: "Always use tools.",
    });
    expect(result.slice(1)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Help me" },
    ]);
  });

  it("merges multiple distinct system messages into a single system message at index 0", () => {
    const messages = [
      { role: "system", content: "Base instructions." },
      { role: "user", content: "First turn" },
      { role: "system", content: "<system-reminder>Tool mode is active.</system-reminder>" },
      { role: "user", content: "Second turn" },
      { role: "system", content: "<system-reminder>Do not disclose secrets.</system-reminder>" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);

    // Exactly one system message, at index 0 (satisfies Qwen loop.first check)
    const systemMessages = result.filter((m) => m.role === "system");
    expect(systemMessages.length).toBe(1);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe(
      "Base instructions.\n\n<system-reminder>Tool mode is active.</system-reminder>\n\n<system-reminder>Do not disclose secrets.</system-reminder>"
    );

    // Other messages follow in original relative order
    expect(result.slice(1)).toEqual([
      { role: "user", content: "First turn" },
      { role: "user", content: "Second turn" },
    ]);
  });

  it("deduplicates exact repeated system messages before merging", () => {
    const messages = [
      { role: "system", content: "System reminder A" },
      { role: "user", content: "User 1" },
      { role: "system", content: "System reminder A" },
      { role: "user", content: "User 2" },
      { role: "system", content: "System reminder B" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);

    expect(result.filter((m) => m.role === "system").length).toBe(1);
    expect(result[0].content).toBe("System reminder A\n\nSystem reminder B");
  });

  it("converts Anthropic block array in system message to clean string", () => {
    const messages = [
      {
        role: "system",
        content: [
          { type: "text", text: "You are Claude." },
          { type: "text", text: "You have tools." },
        ],
      },
      { role: "user", content: "Hello" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);

    expect(result.length).toBe(2);
    expect(result[0]).toEqual({
      role: "system",
      content: "You are Claude.\n\nYou have tools.",
    });
    expect(typeof result[0].content).toBe("string");
  });

  it("handles messages with no system role", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);
    expect(result).toEqual(messages);
  });

  it("handles messages with only system roles", () => {
    const messages = [
      { role: "system", content: "Prompt 1" },
      { role: "system", content: "Prompt 2" },
    ];
    const result = normalizeSystemMessagesForOpenAI(messages, true);
    expect(result).toEqual([
      { role: "system", content: "Prompt 1\n\nPrompt 2" },
    ]);
  });
});
