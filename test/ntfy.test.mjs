/**
 * Test suite for src/ntfy.mjs
 *
 * Coverage:
 * - sendNotification: URL construction, HTTP method, headers, body, actions
 * - waitForResponse: SSE streaming, requestId filtering, timeout handling
 * - formatToolInfo: formatting for Bash, Read, and Write tools
 *
 * TDD Red phase — all tests must FAIL because the implementation does not exist yet.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { sendNotification, waitForResponse, formatToolInfo, stripMarkdown, buildAuthHeader } from "../src/ntfy.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetch that captures the request and returns a canned response.
 */
function createMockFetch(responseBody = {}, status = 200) {
  const calls = [];
  const fn = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  });
  fn.calls = calls;
  return fn;
}

/**
 * Creates a ReadableStream that emits newline-delimited JSON lines (SSE-style)
 * after a short delay, then closes.
 */
function createSSEStream(events) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        // Small delay to simulate network
        await new Promise((r) => setTimeout(r, 10));
      }
      controller.close();
    },
  });
}

/**
 * Creates a mock fetch that returns a streaming response (for SSE subscriptions).
 */
function createStreamingMockFetch(events) {
  const calls = [];
  const fn = mock.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      body: createSSEStream(events),
    };
  });
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// buildAuthHeader
// ---------------------------------------------------------------------------

describe("buildAuthHeader", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildAuthHeader, "function");
  });

  it("should return empty object when auth is null", () => {
    const result = buildAuthHeader(null);
    assert.deepEqual(result, {});
  });

  it("should return empty object when auth is undefined", () => {
    const result = buildAuthHeader(undefined);
    assert.deepEqual(result, {});
  });

  it("should return Authorization header with Basic base64 when auth has username and password", () => {
    const result = buildAuthHeader({ username: "user", password: "pass" });
    // btoa("user:pass") === "dXNlcjpwYXNz"
    assert.deepEqual(result, { Authorization: "Basic dXNlcjpwYXNz" });
  });

  it("should handle special characters in username and password", () => {
    const result = buildAuthHeader({ username: "user@domain", password: "p@ss:word" });
    const expected = `Basic ${btoa("user@domain:p@ss:word")}`;
    assert.deepEqual(result, { Authorization: expected });
  });
});

// ---------------------------------------------------------------------------
// sendNotification
// ---------------------------------------------------------------------------

describe("sendNotification", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should be a function exported from the module", () => {
    assert.equal(typeof sendNotification, "function");
  });

  it("should POST to the base server URL for JSON publishing", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "my-topic",
      title: "Test",
      message: "Hello",
      actions: [],
      requestId: "req-001",
    });

    assert.equal(mockFetch.calls.length, 1);
    assert.equal(mockFetch.calls[0].url, "https://ntfy.sh");
  });

  it("should use HTTP POST method", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions: [],
      requestId: "req-002",
    });

    assert.equal(mockFetch.calls[0].options.method, "POST");
  });

  it("should send Content-Type: application/json header", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions: [],
      requestId: "req-003",
    });

    const headers = mockFetch.calls[0].options.headers;
    // Headers may be a plain object or Headers instance
    const contentType =
      headers instanceof Headers
        ? headers.get("Content-Type")
        : headers["Content-Type"];
    assert.equal(contentType, "application/json");
  });

  it("should include title and message in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Approval Needed",
      message: "Run bash command?",
      actions: [],
      requestId: "req-004",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.title, "Approval Needed");
    assert.equal(body.message, "Run bash command?");
  });

  it("should include actions in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    const actions = [
      {
        action: "http",
        label: "Approve",
        url: "https://ntfy.sh/my-response",
        method: "POST",
        body: JSON.stringify({ requestId: "req-005", approved: true }),
      },
      {
        action: "http",
        label: "Deny",
        url: "https://ntfy.sh/my-response",
        method: "POST",
        body: JSON.stringify({ requestId: "req-005", approved: false }),
      },
    ];

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "Title",
      message: "Body",
      actions,
      requestId: "req-005",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.ok(Array.isArray(body.actions), "body.actions should be an array");
    assert.equal(body.actions.length, 2);
    assert.equal(body.actions[0].label, "Approve");
    assert.equal(body.actions[1].label, "Deny");
  });

  it("should include the topic in the JSON body", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "my-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-006",
    });

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.topic, "my-topic");
  });

  it("should return the fetch response", async () => {
    const mockFetch = createMockFetch({ id: "abc123" }, 200);
    globalThis.fetch = mockFetch;

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-007",
    });

    assert.ok(result, "should return a response object");
    assert.equal(result.status, 200);
  });

  it("should throw when fetch returns non-ok status", async () => {
    const mockFetch = createMockFetch({}, 500);
    globalThis.fetch = mockFetch;

    await assert.rejects(
      () =>
        sendNotification({
          server: "https://ntfy.sh",
          topic: "test-topic",
          title: "T",
          message: "M",
          actions: [],
          requestId: "req-err",
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("HTTP 500"),
          `Error message should include status code, got: "${err.message}"`
        );
        return true;
      }
    );
  });

  it("should handle server URLs with trailing slash", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh/",
      topic: "my-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-008",
    });

    // Should strip trailing slash and POST to base URL only
    assert.equal(mockFetch.calls[0].url, "https://ntfy.sh");
  });

  // ==================== Auth ====================

  it("should include Authorization header when auth is provided", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-auth1",
      auth: { username: "myuser", password: "mypass" },
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      `Basic ${btoa("myuser:mypass")}`,
      "Authorization header should contain Basic auth with base64-encoded credentials"
    );
  });

  it("should NOT include Authorization header when auth is not provided", async () => {
    const mockFetch = createMockFetch();
    globalThis.fetch = mockFetch;

    await sendNotification({
      server: "https://ntfy.sh",
      topic: "test-topic",
      title: "T",
      message: "M",
      actions: [],
      requestId: "req-noauth1",
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      undefined,
      "Authorization header should not be present when auth is not provided"
    );
  });
});

// ---------------------------------------------------------------------------
// waitForResponse
// ---------------------------------------------------------------------------

describe("waitForResponse", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should be a function exported from the module", () => {
    assert.equal(typeof waitForResponse, "function");
  });

  it("should subscribe to the response topic via GET", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-100", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-100",
      timeout: 5000,
    });

    assert.equal(mockFetch.calls.length, 1);
    const url = mockFetch.calls[0].url;
    assert.ok(
      url.includes("my-topic-response"),
      `URL should include response topic, got: ${url}`
    );
  });

  it("should return { approved: true } when a matching requestId with approved:true is received", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-200", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-200",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  it("should return { approved: false } when a matching requestId with approved:false is received", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-201", approved: false }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-201",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: false, alwaysAllow: false });
  });

  it("should filter messages by requestId and ignore non-matching ones", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "other-id", approved: true }),
      },
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-300", approved: false }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-300",
      timeout: 5000,
    });

    // Should skip the first event (wrong requestId) and return the second
    assert.deepEqual(result, { approved: false, alwaysAllow: false });
  });

  it("should return { timeout: true } on timeout", async () => {
    // Stream that never sends a matching event — just stays open
    const neverMatchStream = new ReadableStream({
      start() {
        // Never enqueue anything, never close — simulates waiting forever
      },
    });
    const mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      body: neverMatchStream,
    }));
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-timeout",
      timeout: 200, // Very short timeout for fast test
    });

    assert.deepEqual(result, { timeout: true });
  });

  it("should connect to {server}/{topic}-response/json endpoint", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-400", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-400",
      timeout: 5000,
    });

    const url = mockFetch.calls[0].url;
    assert.equal(
      url,
      "https://ntfy.sh/my-topic-response/json",
      `Expected SSE endpoint URL, got: ${url}`
    );
  });

  it("should abort the SSE connection after receiving a matching response", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-abort", approved: true }),
      },
    ];

    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const mockFetch = mock.fn(async (url, options) => {
      capturedSignal = options?.signal;
      return {
        ok: true,
        status: 200,
        body: createSSEStream(events),
      };
    });
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-abort",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
    assert.ok(capturedSignal, "fetch should have been called with a signal");
    assert.equal(
      capturedSignal.aborted,
      true,
      "AbortController should be aborted after matching response to close SSE connection"
    );
  });

  it("should return { answer: string } when matching requestId has an answer field", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-ans", answer: "Option A" }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-ans",
      timeout: 5000,
    });

    assert.deepEqual(result, { answer: "Option A" });
  });

  it("should return { error: Error } on network error", async () => {
    const networkError = new Error("ECONNREFUSED");
    const mockFetch = mock.fn(async () => {
      throw networkError;
    });
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-err",
      timeout: 5000,
    });

    assert.ok(result.error instanceof Error, "should have error property");
    assert.equal(result.error.message, "ECONNREFUSED");
  });

  it("should prioritize answer over approved when both are present", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-both", approved: true, answer: "Option B" }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-both",
      timeout: 5000,
    });

    assert.deepEqual(result, { answer: "Option B" });
  });

  it("should return { approved: true, alwaysAllow: true } when response includes alwaysAllow: true", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-aa1", approved: true, alwaysAllow: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-aa1",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: true });
  });

  it("should return { approved: true, alwaysAllow: false } when response does not include alwaysAllow", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-aa2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    const result = await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-aa2",
      timeout: 5000,
    });

    assert.deepEqual(result, { approved: true, alwaysAllow: false });
  });

  // ==================== Auth ====================

  it("should include Authorization header when auth is provided", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-auth2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-auth2",
      timeout: 5000,
      auth: { username: "myuser", password: "mypass" },
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers.Authorization,
      `Basic ${btoa("myuser:mypass")}`,
      "Authorization header should contain Basic auth with base64-encoded credentials"
    );
  });

  it("should NOT include Authorization header when auth is not provided", async () => {
    const events = [
      {
        event: "message",
        message: JSON.stringify({ requestId: "req-noauth2", approved: true }),
      },
    ];
    const mockFetch = createStreamingMockFetch(events);
    globalThis.fetch = mockFetch;

    await waitForResponse({
      server: "https://ntfy.sh",
      topic: "my-topic",
      requestId: "req-noauth2",
      timeout: 5000,
    });

    const headers = mockFetch.calls[0].options.headers;
    assert.equal(
      headers,
      undefined,
      "No headers object should be present when auth is not provided"
    );
  });
});

// ---------------------------------------------------------------------------
// formatToolInfo
// ---------------------------------------------------------------------------

describe("formatToolInfo", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof formatToolInfo, "function");
  });

  it("should return an object with title and message properties", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });

    assert.ok(
      typeof result === "object" && result !== null,
      "should return an object"
    );
    assert.ok("title" in result, "result should have a title property");
    assert.ok("message" in result, "result should have a message property");
  });

  it("should include the tool name in the title", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    });

    assert.ok(
      result.title.includes("Bash"),
      `Title should include tool name "Bash", got: "${result.title}"`
    );
  });

  it("should format Bash tool input showing the command", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
    });

    assert.ok(
      result.message.includes("npm install express"),
      `Message should include the command, got: "${result.message}"`
    );
  });

  it("should format Read tool input showing the file path", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/home/user/project/src/index.ts" },
    });

    assert.ok(
      result.message.includes("/home/user/project/src/index.ts"),
      `Message should include the file path, got: "${result.message}"`
    );
  });

  it("should format Write tool input showing the file path", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/project/config.json",
        content: '{ "key": "value" }',
      },
    });

    assert.ok(
      result.message.includes("/home/user/project/config.json"),
      `Message should include the file path, got: "${result.message}"`
    );
  });

  it("should return string values for both title and message", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    });

    assert.equal(typeof result.title, "string", "title should be a string");
    assert.equal(typeof result.message, "string", "message should be a string");
  });

  it("should handle Bash tool input with missing command property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { description: "no command here" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since command is undefined
    assert.ok(
      result.message.includes("no command here"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle Read tool input with missing file_path property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { content: "some content" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since file_path is undefined
    assert.ok(
      result.message.includes("some content"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle Edit tool input with missing file_path property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { old_string: "foo", new_string: "bar" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since file_path is undefined
    assert.ok(
      result.message.includes("foo"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle unknown tool names gracefully", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "UnknownTool",
      tool_input: { some: "data" },
    });

    assert.ok(
      typeof result === "object" && result !== null,
      "should still return an object"
    );
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
  });

  // ==================== Plan Approval Notification ====================

  it("should return title 'Claude Code: Plan Review' when tool_input contains a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# My Plan\n\n## Steps\n1. Do something" },
    });

    assert.equal(
      result.title,
      "Claude Code: Plan Review",
      `Title should be "Claude Code: Plan Review" for plan inputs, got: "${result.title}"`
    );
  });

  it("should strip markdown headers from plan text in the message", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: {
        plan: "# My Plan\n\n## Context\nSome context here\n\n## Steps\n1. First step",
      },
    });

    assert.ok(
      !result.message.includes("#"),
      `Message should not contain markdown "#" headers, got: "${result.message}"`
    );
    assert.ok(
      result.message.includes("My Plan"),
      `Message should contain plan title text, got: "${result.message}"`
    );
    assert.ok(
      result.message.includes("Some context here"),
      `Message should contain plan body text, got: "${result.message}"`
    );
  });

  it("should truncate plan text to 1000 characters and append '...' when it exceeds the limit", () => {
    const longPlan = "# Plan\n\n" + "A".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: longPlan },
    });

    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.length > 303,
      `Message should use 1000-char limit (not old 300-char limit), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      `Message should end with "..." when truncated, got: "${result.message.slice(-10)}"`
    );
  });

  it("should truncate long Bash command to 1000 characters and append '...'", () => {
    const longCommand = "x".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: longCommand },
    });

    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      `Message should end with "..." when truncated`
    );
  });

  it("should not truncate messages shorter than 1000 characters", () => {
    const shortCommand = "x".repeat(500);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: shortCommand },
    });

    assert.equal(
      result.message,
      shortCommand,
      "Short messages should not be truncated"
    );
  });

  it("should not truncate a message that is exactly 1000 characters", () => {
    const exactCommand = "x".repeat(1000);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: exactCommand },
    });
    assert.equal(
      result.message,
      exactCommand,
      "Exactly 1000-char message should not be truncated"
    );
  });

  it("should truncate long messages from unknown tools via default branch", () => {
    const largeInput = { data: "y".repeat(1500) };
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "UnknownTool",
      tool_input: largeInput,
    });
    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      "Message should end with '...' when truncated"
    );
  });

  // ==================== Plan Detection Edge Cases ====================

  it("should not crash when tool_input.plan is a non-string truthy value", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: true },
    });
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
    // Should NOT be "Claude Code: Plan Review" since plan is not a string
    assert.ok(!result.title.includes("Plan Review"), `Non-string plan should not trigger plan detection, got: "${result.title}"`);
  });

  it("should not crash when tool_input.plan is a number", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 42 },
    });
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
  });

  it("should return a fallback message when plan is an empty string", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '' },
    });
    assert.equal(result.title, "Claude Code: Plan Review");
    assert.equal(result.message, "(empty plan)");
  });

  it("should not trigger plan detection for non-ExitPlanMode tools with a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo test', plan: 'some field' },
    });
    assert.equal(result.title, "Claude Code: Bash");
    assert.ok(result.message.includes("echo test"), `Should format as Bash command, got: "${result.message}"`);
  });

  // ==================== Markdown Stripping Edge Cases ====================

  it("should return '(empty plan)' when plan contains only markdown headers", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# \n## \n### ' },
    });
    assert.equal(result.title, "Claude Code: Plan Review");
    assert.equal(result.message, "(empty plan)");
  });

  // ==================== Custom titlePrefix ====================

  it("should use custom titlePrefix for tool notifications", () => {
    const result = formatToolInfo(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      { titlePrefix: "My Claude" },
    );
    assert.equal(result.title, "My Claude: Bash");
  });

  it("should use custom titlePrefix for plan review notifications", () => {
    const result = formatToolInfo(
      { hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "do stuff" } },
      { titlePrefix: "Work PC" },
    );
    assert.equal(result.title, "Work PC: Plan Review");
  });

  it("should fall back to 'Claude Code' when titlePrefix is not provided", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test" },
    });
    assert.equal(result.title, "Claude Code: Read");
  });

  it("should use empty titlePrefix literally when explicitly passed", () => {
    const result = formatToolInfo(
      { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/x" } },
      { titlePrefix: "" },
    );
    assert.equal(result.title, ": Write");
  });
});

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe("stripMarkdown", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof stripMarkdown, "function");
  });

  // ==================== Phase 1: Block-level ====================

  describe("Phase 1: Block-level regex removal", () => {
    it("should strip h1 headers", () => {
      assert.equal(stripMarkdown("# Header"), "Header");
    });

    it("should strip h2 through h6 headers", () => {
      assert.equal(stripMarkdown("## Header 2"), "Header 2");
      assert.equal(stripMarkdown("### Header 3"), "Header 3");
      assert.equal(stripMarkdown("#### Header 4"), "Header 4");
      assert.equal(stripMarkdown("##### Header 5"), "Header 5");
      assert.equal(stripMarkdown("###### Header 6"), "Header 6");
    });

    it("should strip unordered list markers (-, *, +)", () => {
      assert.equal(stripMarkdown("- Item one"), "Item one");
      assert.equal(stripMarkdown("* Item two"), "Item two");
      assert.equal(stripMarkdown("+ Item three"), "Item three");
    });

    it("should strip ordered list markers", () => {
      assert.equal(stripMarkdown("1. First"), "First");
      assert.equal(stripMarkdown("23. Twenty-third"), "Twenty-third");
    });

    it("should strip fenced code blocks with closing fence", () => {
      const input = "Before\n\n```javascript\nconsole.log('hello');\n```\n\nAfter";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("```"), `Should not contain fence markers, got: "${result}"`);
      assert.ok(!result.includes("console.log"), `Should not contain code block content, got: "${result}"`);
      assert.ok(result.includes("Before"), `Should keep text before code block`);
      assert.ok(result.includes("After"), `Should keep text after code block`);
    });

    it("should strip unclosed fenced code blocks to end of string", () => {
      const input = "Before\n\n```python\nprint('leaked')\n# no closing fence";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("```"), `Should not contain fence markers, got: "${result}"`);
      assert.ok(!result.includes("print"), `Should not contain code block content, got: "${result}"`);
      assert.ok(result.includes("Before"), `Should keep text before code block`);
    });

    it("should not process markdown syntax inside code blocks", () => {
      const input = "Text\n\n```\n# Not a header\n**not bold**\n[not a link](url)\n```\n\nEnd";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("# Not a header"), `Code block content should be removed entirely, got: "${result}"`);
      assert.ok(!result.includes("**not bold**"), `Code block content should be removed entirely, got: "${result}"`);
      assert.ok(result.includes("Text"), `Should keep text before code block`);
      assert.ok(result.includes("End"), `Should keep text after code block`);
    });
  });

  // ==================== Phase 2: Inline-level ====================

  describe("Phase 2: Inline-level character-scanning parser", () => {
    it("should strip inline code backticks", () => {
      assert.equal(stripMarkdown("Use `code` here"), "Use code here");
    });

    it("should strip basic markdown links", () => {
      assert.equal(stripMarkdown("[text](url)"), "text");
    });

    it("should strip links with nested brackets in link text", () => {
      assert.equal(stripMarkdown("[text [inner]](url)"), "text [inner]");
    });

    it("should strip links with parentheses in URL", () => {
      assert.equal(
        stripMarkdown("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"),
        "Foo"
      );
    });

    it("should strip bold markers", () => {
      assert.equal(stripMarkdown("**bold**"), "bold");
    });

    it("should strip italic markers", () => {
      assert.equal(stripMarkdown("*italic*"), "italic");
    });

    it("should preserve arithmetic asterisks", () => {
      assert.equal(stripMarkdown("3*4*5"), "3*4*5");
    });

    it("should strip bold inside link text", () => {
      assert.equal(stripMarkdown("[**bold link**](url)"), "bold link");
    });

    it("should preserve literal backtick when unclosed", () => {
      assert.equal(stripMarkdown("text ` more"), "text ` more");
    });
  });

  // ==================== Phase 3: Whitespace normalization ====================

  describe("Phase 3: Whitespace normalization", () => {
    it("should collapse multiple newlines to single newline", () => {
      assert.equal(stripMarkdown("Line one\n\n\n\nLine two"), "Line one\nLine two");
    });

    it("should trim leading and trailing whitespace", () => {
      assert.equal(stripMarkdown("  hello world  "), "hello world");
    });
  });

  // ==================== Edge Cases ====================

  describe("Edge cases", () => {
    it("should return empty string for empty input", () => {
      assert.equal(stripMarkdown(""), "");
    });

    it("should return string unchanged when no markdown is present", () => {
      assert.equal(stripMarkdown("plain text here"), "plain text here");
    });

    it("should return empty string for whitespace-only input", () => {
      assert.equal(stripMarkdown("   \n\n  \t  "), "");
    });
  });

  // ==================== MAJOR-2: Triple asterisk bold+italic ====================

  describe("Triple asterisk bold+italic", () => {
    it("should strip triple asterisk bold+italic", () => {
      assert.equal(stripMarkdown("***text***"), "text");
    });
  });

  // ==================== MINOR-1: Underscore emphasis ====================

  describe("Underscore emphasis", () => {
    it("should strip underscore italic", () => {
      assert.equal(stripMarkdown("_italic_"), "italic");
    });

    it("should strip double underscore bold", () => {
      assert.equal(stripMarkdown("__bold__"), "bold");
    });

    it("should preserve underscores within words", () => {
      assert.equal(stripMarkdown("foo_bar_baz"), "foo_bar_baz");
    });
  });

  // ==================== MINOR-2: Image syntax ====================

  describe("Image syntax", () => {
    it("should strip image syntax and keep alt text", () => {
      assert.equal(stripMarkdown("![alt text](image.png)"), "alt text");
    });
  });

  // ==================== MINOR-3: Indented list markers ====================

  describe("Indented list markers", () => {
    it("should strip indented unordered list markers", () => {
      assert.equal(stripMarkdown("  - indented item"), "indented item");
    });

    it("should strip indented ordered list markers", () => {
      assert.equal(stripMarkdown("    1. deep item"), "deep item");
    });
  });

  // ==================== MINOR-4: Block quotes ====================

  describe("Block quotes", () => {
    it("should strip block quote markers", () => {
      assert.equal(stripMarkdown("> quoted text"), "quoted text");
    });

    it("should strip nested block quote markers", () => {
      assert.equal(stripMarkdown("> > deeply quoted"), "deeply quoted");
    });
  });

  // ==================== MINOR-5: Horizontal rules ====================

  describe("Horizontal rules", () => {
    it("should strip horizontal rules (---)", () => {
      assert.equal(stripMarkdown("above\n---\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules (***)", () => {
      assert.equal(stripMarkdown("above\n***\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules (___)", () => {
      assert.equal(stripMarkdown("above\n___\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules with 4+ underscores (____)", () => {
      assert.equal(stripMarkdown("above\n____\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules with 4+ asterisks (****)", () => {
      assert.equal(stripMarkdown("above\n****\nbelow"), "above\nbelow");
    });

    it("should strip spaced horizontal rules with 4+ chars (* * * *)", () => {
      assert.equal(stripMarkdown("above\n* * * *\nbelow"), "above\nbelow");
    });
  });

  // ==================== MINOR-6: Empty emphasis ====================

  describe("Empty emphasis", () => {
    it("should treat inline **** as literal when there is no content between markers", () => {
      assert.equal(stripMarkdown("text **** text"), "text **** text");
    });
  });

  // ==================== MINOR-7: Backslash escapes ====================

  describe("Backslash escapes", () => {
    it("should handle backslash-escaped asterisks", () => {
      assert.equal(stripMarkdown("\\*not bold\\*"), "*not bold*");
    });

    it("should handle backslash-escaped brackets", () => {
      assert.equal(stripMarkdown("\\[not a link\\](url)"), "[not a link](url)");
    });
  });

  // ==================== Suggestion-3: Strikethrough ====================

  describe("Strikethrough", () => {
    it("should strip strikethrough syntax", () => {
      assert.equal(stripMarkdown("~~removed~~"), "removed");
    });

    it("should strip strikethrough in context", () => {
      assert.equal(stripMarkdown("keep ~~removed~~ keep"), "keep removed keep");
    });

    it("should treat empty strikethrough ~~~~ as literal", () => {
      assert.equal(stripMarkdown("~~~~"), "~~~~");
    });

    it("should treat inline ~~~~ as literal", () => {
      assert.equal(stripMarkdown("text ~~~~ text"), "text ~~~~ text");
    });
  });

  // ==================== Cross-construct interactions ====================

  describe("Cross-construct interactions", () => {
    it("should not treat escaped asterisk as emphasis closer", () => {
      assert.equal(stripMarkdown("*foo \\* bar*"), "foo * bar");
    });

    it("should handle double backtick code spans", () => {
      assert.equal(stripMarkdown("``code with ` inside``"), "code with ` inside");
    });

    it("should not treat brackets inside code spans as link structure", () => {
      assert.equal(stripMarkdown("[outside `]`](url)"), "outside ]");
    });

    it("should handle multiple brackets with code spans in between", () => {
      assert.equal(stripMarkdown("[a `]` b](url)"), "a ] b");
    });
  });
});
