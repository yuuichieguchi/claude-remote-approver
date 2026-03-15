/**
 * Test suite for src/hook.mjs
 *
 * Coverage:
 * - buildActions: returns correct structure with 2 actions (Approve / Deny)
 * - buildActions: URLs point to the response topic ({topic}-response)
 * - processHook: returns allow decision when waitForResponse returns approved:true
 * - processHook: returns deny decision when waitForResponse returns approved:false
 * - processHook: returns deny with message when config has no topic
 * - processHook: calls sendNotification with correct parameters
 * - processHook: calls waitForResponse with correct topic and timeout
 *
 * TDD Red phase — all tests must FAIL because the implementation is a stub.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processHook, buildActions, sendWithRetry, RETRY_DELAY_MS, _internal, isAskUserQuestion, buildQuestionActions, buildQuestionMessage, processAskUserQuestion } from "../src/hook.mjs";

// Dynamic import helper — buildAuthHeader does not exist yet (TDD Red phase).
// Using a lazy getter avoids a static import error that would prevent ALL tests from loading.
let _buildAuthHeader;
async function getBuildAuthHeader() {
  if (_buildAuthHeader !== undefined) return _buildAuthHeader;
  try {
    const mod = await import("../src/ntfy.mjs");
    if (typeof mod.buildAuthHeader !== "function") {
      throw new Error("buildAuthHeader is not exported from ntfy.mjs");
    }
    _buildAuthHeader = mod.buildAuthHeader;
  } catch {
    _buildAuthHeader = null;
  }
  return _buildAuthHeader;
}

// ---------------------------------------------------------------------------
// buildActions
// ---------------------------------------------------------------------------

describe("buildActions", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildActions, "function");
  });

  it("should return an array with exactly 2 actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-001");

    assert.ok(Array.isArray(actions), "should return an array");
    assert.equal(actions.length, 2, "should have exactly 2 actions");
  });

  it("should have Approve as the first action and Deny as the second", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-002");

    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Deny");
  });

  it("should set action type to 'http' for both actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-003");

    assert.equal(actions[0].action, "http");
    assert.equal(actions[1].action, "http");
  });

  it("should use response topic URLs ({topic}-response)", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-004");

    assert.equal(
      actions[0].url,
      "https://ntfy.sh/my-topic-response",
      `Approve URL should use response topic, got: ${actions[0].url}`
    );
    assert.equal(
      actions[1].url,
      "https://ntfy.sh/my-topic-response",
      `Deny URL should use response topic, got: ${actions[1].url}`
    );
  });

  it("should use POST method for both actions", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-005");

    assert.equal(actions[0].method, "POST");
    assert.equal(actions[1].method, "POST");
  });

  it("should not include Content-Type header to avoid ntfy JSON publishing mode", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-006");

    assert.equal(actions[0].headers, undefined);
    assert.equal(actions[1].headers, undefined);
  });

  it("should include requestId and approved:true in Approve body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-007");

    const body = JSON.parse(actions[0].body);
    assert.equal(body.requestId, "req-007");
    assert.equal(body.approved, true);
  });

  it("should include requestId and approved:false in Deny body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-008");

    const body = JSON.parse(actions[1].body);
    assert.equal(body.requestId, "req-008");
    assert.equal(body.approved, false);
  });

  it("should handle custom server URLs correctly", () => {
    const actions = buildActions(
      "https://custom.ntfy.example.com",
      "cra-abc123",
      "req-009"
    );

    assert.equal(
      actions[0].url,
      "https://custom.ntfy.example.com/cra-abc123-response"
    );
    assert.equal(
      actions[1].url,
      "https://custom.ntfy.example.com/cra-abc123-response"
    );
  });

  // ==================== Always Approve ====================

  it("should return 3 actions when permissionSuggestions is provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa1", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    assert.equal(actions.length, 3);
  });

  it("should place Always Approve between Approve and Deny", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa2", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Always Approve");
    assert.equal(actions[2].label, "Deny");
  });

  it("should include alwaysAllow: true in Always Approve button body", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa3", {
      permissionSuggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    });
    const body = JSON.parse(actions[1].body);
    assert.equal(body.requestId, "req-aa3");
    assert.equal(body.approved, true);
    assert.equal(body.alwaysAllow, true);
  });

  it("should return 2 actions when permissionSuggestions is empty", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa4", {
      permissionSuggestions: [],
    });
    assert.equal(actions.length, 2);
    assert.equal(actions[0].label, "Approve");
    assert.equal(actions[1].label, "Deny");
  });

  it("should return 2 actions when no options object is provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-aa5");
    assert.equal(actions.length, 2);
  });

  // ==================== Auth (Basic Auth headers) ====================

  it("should include headers with Authorization on each action when auth is provided", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "user", password: "pass" };
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-auth1", { auth });
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of actions) {
      assert.deepEqual(action.headers, expectedHeaders);
    }
  });

  it("should NOT include headers property on actions when auth is not provided", () => {
    const actions = buildActions("https://ntfy.sh", "my-topic", "req-auth2");
    for (const action of actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is not provided");
    }
  });
});

// ---------------------------------------------------------------------------
// processHook
// ---------------------------------------------------------------------------

describe("processHook", () => {
  /**
   * Creates a standard set of dependency stubs for processHook.
   * Override individual stubs as needed in each test.
   */
  function createDeps(overrides = {}) {
    const defaultConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };

    return {
      loadConfig: mock.fn(() => overrides.config ?? defaultConfig),
      sendNotification: mock.fn(async () => ({ messageId: "msg-001" })),
      deleteNotification: mock.fn(async () => {}),
      waitForResponse: mock.fn(
        async () => overrides.waitResult ?? { approved: true }
      ),
      formatToolInfo: mock.fn(() => overrides.toolInfo ?? {
        title: "Claude Code: Bash",
        message: "echo hello",
      }),
      ...overrides,
    };
  }

  /** Standard input mimicking a Claude Code hook payload. */
  const sampleInput = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  };

  it("should be a function exported from the module", () => {
    assert.equal(typeof processHook, "function");
  });

  // ==================== Happy Path: Approve ====================

  it("should return allow decision when waitForResponse returns approved:true", async () => {
    const deps = createDeps({ waitResult: { approved: true } });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  // ==================== Happy Path: Deny ====================

  it("should return deny decision when waitForResponse returns approved:false", async () => {
    const deps = createDeps({ waitResult: { approved: false } });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  // ==================== No Topic Configured ====================

  it("should return ask when config has no topic set", async () => {
    const noTopicConfig = {
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: noTopicConfig });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should not call sendNotification when config has no topic", async () => {
    const noTopicConfig = {
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: noTopicConfig });

    await processHook(sampleInput, deps);

    assert.equal(
      deps.sendNotification.mock.callCount(),
      0,
      "sendNotification should not be called when topic is empty"
    );
  });

  // ==================== sendNotification parameters ====================

  it("should call sendNotification with correct topic from config", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.topic, "test-topic");
  });

  it("should call sendNotification with title and message from formatToolInfo", async () => {
    const deps = createDeps({
      toolInfo: { title: "Claude Code: Read", message: "/path/to/file.ts" },
    });

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.title, "Claude Code: Read");
    assert.equal(callArgs.message, "/path/to/file.ts");
  });

  it("should call sendNotification with actions array containing 2 actions", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(callArgs.actions), "actions should be an array");
    assert.equal(callArgs.actions.length, 2);
  });

  it("should call sendNotification with server from config", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.server, "https://ntfy.sh");
  });

  // ==================== waitForResponse parameters ====================

  it("should call waitForResponse with response topic ({topic}-response)", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.topic,
      "test-topic",
      `waitForResponse should receive the topic, got: ${callArgs.topic}`
    );
  });

  it("should call waitForResponse with timeout from config", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 300,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `timeout should be config.timeout * 1000 (300000), got: ${callArgs.timeout}`
    );
  });

  it("should call waitForResponse with server from config", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://custom.ntfy.example.com",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(callArgs.server, "https://custom.ntfy.example.com");
  });

  // ==================== Error handling ====================

  it("should return ask when all sendNotification retries fail", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const deps = createDeps();
      deps.sendNotification = mock.fn(async () => {
        throw new Error("network error");
      });
      const result = await processHook(sampleInput, deps);

      assert.equal(deps.sendNotification.mock.callCount(), 3, "sendNotification should be called 3 times (retry logic)");
      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "ask" },
        },
      });
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should return ask when waitForResponse throws", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => {
      throw new Error("timeout exceeded");
    });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should log error to console.error when sendNotification throws", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const deps = createDeps();
      deps.sendNotification = mock.fn(async () => {
        throw new Error("network error");
      });
      await processHook(sampleInput, deps);

      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Notification failed after 3 attempts:"),
        `console.error first arg should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "network error", "should include err.message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
      _internal.delay = originalDelay;
    }
  });

  it("should log error to console.error when waitForResponse throws", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => {
      throw new Error("timeout exceeded");
    });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Response listener failed:"),
        `console.error first arg should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "timeout exceeded", "should include err.message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  // ==================== ExitPlanMode timeout ====================

  it("should use planTimeout for ExitPlanMode tool", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });
    const exitPlanInput = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: {},
    };

    await processHook(exitPlanInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `ExitPlanMode timeout should be planTimeout * 1000 (300000), got: ${callArgs.timeout}`
    );
  });

  it("should use regular timeout for non-ExitPlanMode tools", async () => {
    const customConfig = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: customConfig });

    await processHook(sampleInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      120 * 1000,
      `Regular tool timeout should be timeout * 1000 (120000), got: ${callArgs.timeout}`
    );
  });

  it("should fall back to 300s when planTimeout is not set in config for ExitPlanMode", async () => {
    const configWithoutPlanTimeout = {
      topic: "test-topic",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };
    const deps = createDeps({ config: configWithoutPlanTimeout });
    const exitPlanInput = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: {},
    };

    await processHook(exitPlanInput, deps);

    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(
      callArgs.timeout,
      300 * 1000,
      `ExitPlanMode should fall back to 300s (300000), got: ${callArgs.timeout}`
    );
  });

  // ==================== formatToolInfo ====================

  it("should call formatToolInfo with the input", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.formatToolInfo.mock.callCount(), 1);
    const callArgs = deps.formatToolInfo.mock.calls[0].arguments[0];
    assert.equal(callArgs.tool_name, "Bash");
    assert.deepEqual(callArgs.tool_input, { command: "echo hello" });
  });

  // ==================== loadConfig ====================

  it("should call loadConfig exactly once", async () => {
    const deps = createDeps();

    await processHook(sampleInput, deps);

    assert.equal(deps.loadConfig.mock.callCount(), 1);
  });

  // ==================== waitForResponse edge cases ====================

  it("should return ask when waitForResponse returns { timeout: true }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ timeout: true }));

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should return ask when waitForResponse returns { error: Error }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ error: new Error("SSE failure") }));

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "ask" },
      },
    });
  });

  it("should log timeout message to stderr when waitForResponse returns { timeout: true }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ timeout: true }));
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Timed out waiting for response"),
        `should log timeout message with prefix, got: ${args[0]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log error message to stderr when waitForResponse returns { error: Error }", async () => {
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ error: new Error("SSE failure") }));
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processHook(sampleInput, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Response error:"),
        `should log error message with prefix, got: ${args[0]}`
      );
      assert.equal(args[1], "SSE failure", "should include error message");
      assert.ok(
        args[2].includes("Falling back to CLI"),
        `should mention fallback, got: ${args[2]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  // ==================== sendWithRetry via processHook ====================

  it("should succeed on second retry when sendNotification fails once then succeeds", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const deps = createDeps();
      let callCount = 0;
      deps.sendNotification = mock.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first attempt fails");
        return { ok: true, status: 200 };
      });
      const result = await processHook(sampleInput, deps);

      assert.equal(deps.sendNotification.mock.callCount(), 2, "sendNotification should be called twice");
      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should route AskUserQuestion to processAskUserQuestion", async () => {
    const askInput = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which option?",
          header: "Choice",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = createDeps();
    deps.waitForResponse = mock.fn(async () => ({ answer: "A" }));

    const result = await processHook(askInput, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.ok(result.hookSpecificOutput.decision.updatedInput, "Should have updatedInput from processAskUserQuestion");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Which option?": "A" });
  });

  // ==================== Always Approve integration ====================

  it("should pass permission_suggestions to buildActions when present in input", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps();
    await processHook(inputWithSuggestions, deps);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.actions.length, 3, "Should have 3 actions (Approve, Always Approve, Deny)");
    assert.equal(callArgs.actions[1].label, "Always Approve");
  });

  it("should return updatedPermissions when alwaysAllow is true and permission_suggestions exist", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: true } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
        },
      },
    });
  });

  it("should NOT include updatedPermissions when alwaysAllow is false", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: false } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should NOT include updatedPermissions when alwaysAllow is true but permission_suggestions is absent", async () => {
    const deps = createDeps({ waitResult: { approved: true, alwaysAllow: true } });
    // sampleInput does NOT have permission_suggestions
    const result = await processHook(sampleInput, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should return 2 actions when permissionSuggestions is null in input", async () => {
    const inputWithNull = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: null,
    };
    const deps = createDeps();
    await processHook(inputWithNull, deps);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.actions.length, 2, "Should have 2 actions when permissionSuggestions is null");
  });

  it("should return deny when approved is false even if alwaysAllow is true", async () => {
    const inputWithSuggestions = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
    };
    const deps = createDeps({ waitResult: { approved: false, alwaysAllow: true } });
    const result = await processHook(inputWithSuggestions, deps);
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  // ==================== Auth threading (Basic Auth) ====================

  it("should pass auth to sendNotification when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "sendNotification should receive auth in params");
  });

  it("should pass auth to waitForResponse when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "waitForResponse should receive auth in params");
  });

  it("should pass auth to buildActions so actions have Authorization headers", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of callArgs.actions) {
      assert.deepEqual(action.headers, expectedHeaders, "each action should have Authorization headers");
    }
  });

  // ==================== deleteNotification ====================

  it("should call deleteNotification with messageId after response", async () => {
    const deps = createDeps({ waitResult: { approved: true } });

    await processHook(sampleInput, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 1);
    const callArgs = deps.deleteNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.server, "https://ntfy.sh");
    assert.equal(callArgs.topic, "test-topic");
    assert.equal(callArgs.messageId, "msg-001");
  });

  it("should pass auth to deleteNotification when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const deps = createDeps({ waitResult: { approved: true } });
    deps.resolveAuth = mock.fn(() => auth);

    await processHook(sampleInput, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 1);
    const callArgs = deps.deleteNotification.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth);
  });

  it("should not call deleteNotification when messageId is undefined", async () => {
    const deps = createDeps({ waitResult: { approved: true } });
    deps.sendNotification = mock.fn(async () => ({ messageId: undefined }));

    await processHook(sampleInput, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 0);
  });

  it("should not fail when deleteNotification throws", async () => {
    const deps = createDeps({ waitResult: { approved: true } });
    deps.deleteNotification = mock.fn(async () => { throw new Error("delete failed"); });

    const result = await processHook(sampleInput, deps);

    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should still call deleteNotification when response times out", async () => {
    const deps = createDeps({ waitResult: { timeout: true } });
    const errorSpy = mock.method(console, "error", () => {});
    try {
      await processHook(sampleInput, deps);
    } finally {
      errorSpy.mock.restore();
    }

    assert.equal(deps.deleteNotification.mock.callCount(), 1, "should still attempt to dismiss the notification on timeout");
  });

  it("should work without auth when resolveAuth returns null", async () => {
    const deps = createDeps();
    deps.resolveAuth = mock.fn(() => null);

    const result = await processHook(sampleInput, deps);

    // Existing behavior preserved: allow decision
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    // sendNotification should NOT have auth
    const sendArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(sendArgs.auth, undefined, "sendNotification should not have auth when resolveAuth returns null");
    // waitForResponse should NOT have auth
    const waitArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitArgs.auth, undefined, "waitForResponse should not have auth when resolveAuth returns null");
    // Actions should NOT have headers
    for (const action of sendArgs.actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is null");
    }
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry
// ---------------------------------------------------------------------------

describe("sendWithRetry", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof sendWithRetry, "function");
  });

  it("should return the result on first success", async () => {
    const mockSend = mock.fn(async () => ({ ok: true }));
    const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
    assert.deepEqual(result, { ok: true });
    assert.equal(mockSend.mock.callCount(), 1);
  });

  it("should retry up to 3 times and return null on all failures", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const mockSend = mock.fn(async () => { throw new Error("fail"); });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.equal(result, null);
      assert.equal(mockSend.mock.callCount(), 3);
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should succeed on second attempt after first failure", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      let count = 0;
      const mockSend = mock.fn(async () => {
        count++;
        if (count === 1) throw new Error("fail");
        return { ok: true };
      });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.deepEqual(result, { ok: true });
      assert.equal(mockSend.mock.callCount(), 2);
    } finally {
      _internal.delay = originalDelay;
    }
  });

  // ==================== Linear Backoff Delay ====================

  it("should export RETRY_DELAY_MS as 1000", () => {
    assert.equal(typeof RETRY_DELAY_MS, "number", "RETRY_DELAY_MS should be exported as a number");
    assert.equal(RETRY_DELAY_MS, 1000, "RETRY_DELAY_MS should be 1000ms");
  });

  it("should delay between retry attempts with linear backoff", async () => {
    const delayArgs = [];
    const originalDelay = _internal.delay;
    _internal.delay = (ms) => { delayArgs.push(ms); return Promise.resolve(); };
    try {
      const mockSend = mock.fn(async () => { throw new Error("fail"); });
      const result = await sendWithRetry(mockSend, { server: "s", topic: "t" });
      assert.equal(result, null, "should return null after exhausting retries");
      assert.equal(mockSend.mock.callCount(), 3, "should have been called 3 times");
      assert.deepEqual(delayArgs, [1000, 2000], "should delay 1s then 2s (linear backoff)");
    } finally {
      _internal.delay = originalDelay;
    }
  });

});

// ---------------------------------------------------------------------------
// isAskUserQuestion
// ---------------------------------------------------------------------------

describe("isAskUserQuestion", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof isAskUserQuestion, "function");
  });

  it("should return true for AskUserQuestion with questions array", () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "Which?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }],
      },
    };
    assert.equal(isAskUserQuestion(input), true);
  });

  it("should return false for non-AskUserQuestion tools", () => {
    assert.equal(isAskUserQuestion({ tool_name: "Bash", tool_input: { command: "ls" } }), false);
  });

  it("should return false when questions is empty array", () => {
    assert.equal(isAskUserQuestion({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }), false);
  });

  it("should return false when questions is not an array", () => {
    assert.equal(isAskUserQuestion({ tool_name: "AskUserQuestion", tool_input: { questions: "not array" } }), false);
  });

  it("should return false for null input", () => {
    assert.equal(isAskUserQuestion(null), false);
  });

  it("should return false for undefined input", () => {
    assert.equal(isAskUserQuestion(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// buildQuestionActions
// ---------------------------------------------------------------------------

describe("buildQuestionActions", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildQuestionActions, "function");
  });

  it("should return http actions for each option", () => {
    const options = [
      { label: "Option A", description: "desc A" },
      { label: "Option B", description: "desc B" },
    ];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-1", options);

    assert.equal(actions.length, 2);
    assert.equal(actions[0].action, "http");
    assert.equal(actions[0].label, "Option A");
    assert.equal(actions[1].label, "Option B");
  });

  it("should encode answer in the body", () => {
    const options = [{ label: "My Choice", description: "desc" }];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-1", options);

    const body = JSON.parse(actions[0].body);
    assert.equal(body.requestId, "req-1");
    assert.equal(body.answer, "My Choice");
  });

  it("should use {topic}-response URL", () => {
    const options = [{ label: "A", description: "a" }];
    const actions = buildQuestionActions("https://ntfy.sh", "my-topic", "req-1", options);

    assert.equal(actions[0].url, "https://ntfy.sh/my-topic-response");
  });

  // ==================== Auth (Basic Auth headers) ====================

  it("should include headers with Authorization on each action when auth is provided", async () => {
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const auth = { username: "user", password: "pass" };
    const options = [
      { label: "Option A", description: "desc A" },
      { label: "Option B", description: "desc B" },
    ];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-qa1", options, { auth });
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of actions) {
      assert.deepEqual(action.headers, expectedHeaders);
    }
  });

  it("should NOT include headers on actions when auth is not provided", () => {
    const options = [{ label: "A", description: "a" }];
    const actions = buildQuestionActions("https://ntfy.sh", "topic", "req-qa2", options);
    for (const action of actions) {
      assert.equal(action.headers, undefined, "actions should not have headers when auth is not provided");
    }
  });
});

// ---------------------------------------------------------------------------
// buildQuestionMessage
// ---------------------------------------------------------------------------

describe("buildQuestionMessage", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof buildQuestionMessage, "function");
  });

  it("should include the question text", () => {
    const msg = buildQuestionMessage("Which color?", [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }]);
    assert.ok(msg.includes("Which color?"), `Should include question, got: ${msg}`);
  });

  it("should include option labels and descriptions", () => {
    const msg = buildQuestionMessage("Pick one", [
      { label: "A", description: "first option" },
      { label: "B", description: "second option" },
    ]);
    assert.ok(msg.includes("A"), `Should include label A, got: ${msg}`);
    assert.ok(msg.includes("first option"), `Should include description, got: ${msg}`);
  });

  it("should include multiSelect note when specified", () => {
    const msg = buildQuestionMessage("Pick many", [{ label: "X", description: "x" }], { multiSelect: true });
    assert.ok(msg.includes("multiple") || msg.includes("複数"), `Should mention multiple selection, got: ${msg}`);
  });

  it("should include batch info when provided", () => {
    const msg = buildQuestionMessage("Pick", [{ label: "A", description: "a" }], { batchInfo: "(1/2)" });
    assert.ok(msg.includes("(1/2)"), `Should include batch info, got: ${msg}`);
  });
});

// ---------------------------------------------------------------------------
// processAskUserQuestion
// ---------------------------------------------------------------------------

describe("processAskUserQuestion", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof processAskUserQuestion, "function");
  });

  it("should return allow with answers for a single question with answer", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.ok(result.hookSpecificOutput.decision.updatedInput);
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Which?": "A" });
  });

  it("should return ask when sendNotification fails after retries", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Which?",
            header: "Q",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          }],
        },
      };
      const deps = {
        loadConfig: mock.fn(() => ({
          topic: "test-topic",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        sendNotification: mock.fn(async () => { throw new Error("fail"); }),
        waitForResponse: mock.fn(async () => ({ answer: "A" })),
      };
      const result = await processAskUserQuestion(input, deps);

      assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
    } finally {
      _internal.delay = originalDelay;
    }
  });

  it("should return ask when waitForResponse returns timeout", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ timeout: true })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
  });

  it("should split 4 options into 2 notifications", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Pick one",
          header: "Q",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
            { label: "C", description: "c" },
            { label: "D", description: "d" },
          ],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "C" })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 2, "Should send 2 notifications for 4 options");
    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Pick one": "C" });
  });

  it("should split 5 options into 2 notifications (3+2)", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Pick one of five",
          header: "Q",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
            { label: "C", description: "c" },
            { label: "D", description: "d" },
            { label: "E", description: "e" },
          ],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "D" })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 2, "Should send 2 notifications for 5 options (3+2)");
    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Pick one of five": "D" });
  });

  it("should handle multiple questions", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Q1?",
            header: "H1",
            options: [{ label: "A1", description: "a1" }, { label: "B1", description: "b1" }],
            multiSelect: false,
          },
          {
            question: "Q2?",
            header: "H2",
            options: [{ label: "A2", description: "a2" }, { label: "B2", description: "b2" }],
            multiSelect: false,
          },
        ],
      },
    };
    let waitCallCount = 0;
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => {
        waitCallCount++;
        return { answer: waitCallCount === 1 ? "A1" : "B2" };
      }),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { "Q1?": "A1", "Q2?": "B2" });
  });

  it("should log stderr message when waitForResponse throws", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => { throw new Error("connection lost"); }),
    };
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processAskUserQuestion(input, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Response listener failed:"),
        `should have prefix and message, got: ${args[0]}`
      );
      assert.equal(args[1], "connection lost", "should include err.message");
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log stderr message when no answer received (timeout/error)", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ timeout: true })),
    };
    const errorSpy = mock.method(console, "error", () => {});

    try {
      await processAskUserQuestion(input, deps);
      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("No answer received"),
        `should log no answer message with prefix, got: ${args[0]}`
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("should log stderr message when sendNotification fails after retries", async () => {
    const originalDelay = _internal.delay;
    _internal.delay = () => Promise.resolve();
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const input = {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            question: "Which?",
            header: "Q",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          }],
        },
      };
      const deps = {
        loadConfig: mock.fn(() => ({
          topic: "test-topic",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        sendNotification: mock.fn(async () => { throw new Error("rate limited"); }),
        waitForResponse: mock.fn(async () => ({ answer: "A" })),
      };
      await processAskUserQuestion(input, deps);

      assert.equal(errorSpy.mock.callCount(), 1);
      const args = errorSpy.mock.calls[0].arguments;
      assert.ok(
        args[0].includes("[claude-remote-approver]") && args[0].includes("Notification failed after 3 attempts:"),
        `should have prefix and notification failed message, got: ${args[0]}`
      );
      assert.equal(args[1], "rate limited", "should include err.message");
    } finally {
      errorSpy.mock.restore();
      _internal.delay = originalDelay;
    }
  });

  // ==================== deleteNotification ====================

  it("should call deleteNotification with collected messageIds after response", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ messageId: "msg-q1" })),
      deleteNotification: mock.fn(async () => {}),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 1);
    const callArgs = deps.deleteNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.messageId, "msg-q1");
    assert.equal(callArgs.server, "https://ntfy.sh");
    assert.equal(callArgs.topic, "test-topic");
  });

  it("should delete all batch messageIds for multi-batch questions", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Pick one",
          header: "Q",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
            { label: "C", description: "c" },
            { label: "D", description: "d" },
          ],
          multiSelect: false,
        }],
      },
    };
    let callCount = 0;
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => {
        callCount++;
        return { messageId: `msg-batch-${callCount}` };
      }),
      deleteNotification: mock.fn(async () => {}),
      waitForResponse: mock.fn(async () => ({ answer: "C" })),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 2);
    assert.equal(deps.deleteNotification.mock.calls[0].arguments[0].messageId, "msg-batch-1");
    assert.equal(deps.deleteNotification.mock.calls[1].arguments[0].messageId, "msg-batch-2");
  });

  it("should not fail when deleteNotification throws in processAskUserQuestion", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ messageId: "msg-x" })),
      deleteNotification: mock.fn(async () => { throw new Error("delete failed"); }),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
  });

  it("should skip deleteNotification when messageId is missing from sendNotification response", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({})),
      deleteNotification: mock.fn(async () => {}),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.deleteNotification.mock.callCount(), 0);
  });

  it("should still work when deleteNotification is not provided", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ messageId: "msg-y" })),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
    };

    const result = await processAskUserQuestion(input, deps);

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
  });

  // ==================== Auth threading (Basic Auth) ====================

  it("should pass auth to sendNotification when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.sendNotification.mock.callCount(), 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "sendNotification should receive auth in params");
  });

  it("should pass auth to waitForResponse when resolveAuth returns credentials", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    assert.equal(deps.waitForResponse.mock.callCount(), 1);
    const callArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.deepEqual(callArgs.auth, auth, "waitForResponse should receive auth in params");
  });

  it("should pass auth to buildQuestionActions so actions have Authorization headers", async () => {
    const auth = { username: "myuser", password: "mypass" };
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Q",
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
          multiSelect: false,
        }],
      },
    };
    const deps = {
      loadConfig: mock.fn(() => ({
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
      })),
      sendNotification: mock.fn(async () => ({ ok: true })),
      waitForResponse: mock.fn(async () => ({ answer: "A" })),
      resolveAuth: mock.fn(() => auth),
    };

    await processAskUserQuestion(input, deps);

    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    const buildAuthHeaderFn = await getBuildAuthHeader();
    assert.ok(buildAuthHeaderFn, "buildAuthHeader must be exported from ntfy.mjs");
    const expectedHeaders = buildAuthHeaderFn(auth);
    for (const action of callArgs.actions) {
      assert.deepEqual(action.headers, expectedHeaders, "each question action should have Authorization headers");
    }
  });
});
