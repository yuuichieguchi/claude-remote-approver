// src/hook.mjs

import crypto from "node:crypto";
import { DEFAULT_CONFIG } from "./config.mjs";
import { buildAuthHeader } from "./ntfy.mjs";

export const ASK = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: "PermissionRequest", decision: Object.freeze({ behavior: "ask" }) }) });
const DENY = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: "PermissionRequest", decision: Object.freeze({ behavior: "deny" }) }) });
const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
/** @internal Replaceable delay for testing. Do not use outside of tests. */
export const _internal = { delay: ms => new Promise(r => setTimeout(r, ms)) };

/**
 * Build ntfy action buttons for Approve / Deny (and optionally Always Approve).
 *
 * @param {string} server - ntfy server URL
 * @param {string} topic - ntfy topic
 * @param {string} requestId - Unique request identifier
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.permissionSuggestions] - When non-empty, adds an "Always Approve" button
 * @returns {Array<object>} Array of action objects
 */
export function buildActions(server, topic, requestId, { permissionSuggestions, auth } = {}) {
  const url = `${server}/${topic}-response`;
  const authHeaders = auth ? buildAuthHeader(auth) : undefined;
  const actions = [
    {
      action: "http",
      label: "Approve",
      url,
      body: JSON.stringify({ requestId, approved: true }),
      method: "POST",
      clear: true,
      ...(authHeaders && { headers: authHeaders }),
    },
    {
      action: "http",
      label: "Deny",
      url,
      body: JSON.stringify({ requestId, approved: false }),
      method: "POST",
      clear: true,
      ...(authHeaders && { headers: authHeaders }),
    },
  ];
  if (permissionSuggestions?.length > 0) {
    actions.splice(1, 0, {
      action: "http",
      label: "Always Approve",
      url,
      body: JSON.stringify({ requestId, approved: true, alwaysAllow: true }),
      method: "POST",
      clear: true,
      ...(authHeaders && { headers: authHeaders }),
    });
  }
  return actions;
}

/**
 * Send with retry, returning null on exhausted retries.
 * Uses linear backoff: delay = RETRY_DELAY_MS * attempt (1s, 2s, …).
 */
export async function sendWithRetry(sendFn, params) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await sendFn(params);
    } catch (err) {
      if (i === MAX_RETRIES - 1) {
        console.error(`[claude-remote-approver] Notification failed after ${MAX_RETRIES} attempts:`, err.message, "— Falling back to CLI.");
        return null;
      }
      await _internal.delay(RETRY_DELAY_MS * (i + 1));
    }
  }
  return null;
}

/**
 * Check if the input is an AskUserQuestion tool call with questions.
 */
export function isAskUserQuestion(input) {
  return (
    input?.tool_name === "AskUserQuestion" &&
    Array.isArray(input?.tool_input?.questions) &&
    input.tool_input.questions.length > 0
  );
}

/**
 * Build ntfy action buttons for question options.
 */
export function buildQuestionActions(server, topic, requestId, options, { auth } = {}) {
  const url = `${server}/${topic}-response`;
  const authHeaders = auth ? buildAuthHeader(auth) : undefined;
  return options.map((opt) => ({
    action: "http",
    label: opt.label,
    url,
    body: JSON.stringify({ requestId, answer: opt.label }),
    method: "POST",
    clear: true,
    ...(authHeaders && { headers: authHeaders }),
  }));
}

/**
 * Build a human-readable message for a question with options.
 */
export function buildQuestionMessage(question, options, opts = {}) {
  const { multiSelect, batchInfo } = opts;
  let msg = question;
  if (batchInfo) msg += ` ${batchInfo}`;
  if (multiSelect) msg += "\n(multiple selections allowed)";
  msg += "\n\n";
  for (const opt of options) {
    msg += `• ${opt.label}: ${opt.description}\n`;
  }
  return msg.trimEnd();
}

/**
 * Process an AskUserQuestion hook request.
 */
export async function processAskUserQuestion(input, deps) {
  const config = deps.loadConfig();
  if (!config.topic) return ASK;

  const auth = deps.resolveAuth ? deps.resolveAuth(config) : null;
  const questions = input.tool_input.questions;
  const answers = {};

  for (const q of questions) {
    const requestId = crypto.randomUUID();
    const options = q.options;

    const MAX_BUTTONS = 3;
    const batches = [];
    for (let j = 0; j < options.length; j += MAX_BUTTONS) {
      batches.push(options.slice(j, j + MAX_BUTTONS));
    }

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchInfo = batches.length > 1 ? `(${i + 1}/${batches.length})` : undefined;
      const actions = buildQuestionActions(config.ntfyServer, config.topic, requestId, batch, { ...(auth && { auth }) });
      const message = buildQuestionMessage(q.question, batch, { multiSelect: q.multiSelect, batchInfo });

      const sent = await sendWithRetry(deps.sendNotification, {
        server: config.ntfyServer,
        topic: config.topic,
        title: `Claude Code: ${q.header || "Question"}`,
        message,
        actions,
        requestId,
        ...(auth && { auth }),
      });
      if (!sent) return ASK;
    }

    // AskUserQuestion uses standard timeout (not planTimeout)
    let response;
    try {
      response = await deps.waitForResponse({
        server: config.ntfyServer,
        topic: config.topic,
        requestId,
        timeout: config.timeout * 1000,
        ...(auth && { auth }),
      });
    } catch (err) {
      console.error("[claude-remote-approver] Response listener failed:", err.message, "— Falling back to CLI.");
      return ASK;
    }

    if (response.answer) {
      answers[q.question] = response.answer;
    } else {
      console.error("[claude-remote-approver] No answer received. Falling back to CLI.");
      return ASK;
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          questions: input.tool_input.questions,
          answers,
        },
      },
    },
  };
}

/**
 * Process a Claude Code hook request.
 *
 * @param {object} input - The hook input payload
 * @param {object} deps - Injected dependencies
 * @param {Function} deps.loadConfig
 * @param {Function} deps.sendNotification
 * @param {Function} deps.waitForResponse
 * @param {Function} deps.formatToolInfo
 * @returns {Promise<object>} Decision JSON
 */
export async function processHook(input, { loadConfig, sendNotification, waitForResponse, formatToolInfo, resolveAuth }) {
  const config = loadConfig();

  if (!config.topic) {
    return ASK;
  }

  const auth = resolveAuth ? resolveAuth(config) : null;

  if (isAskUserQuestion(input)) {
    return processAskUserQuestion(input, { loadConfig, sendNotification, waitForResponse, resolveAuth });
  }

  const requestId = crypto.randomUUID();
  const { title, message } = formatToolInfo(input);
  const actions = buildActions(config.ntfyServer, config.topic, requestId, {
    permissionSuggestions: input.permission_suggestions,
    ...(auth && { auth }),
  });

  const sent = await sendWithRetry(sendNotification, {
    server: config.ntfyServer,
    topic: config.topic,
    title,
    message,
    actions,
    requestId,
    ...(auth && { auth }),
  });
  if (!sent) return ASK;

  let response;
  try {
    const isPlanReview = input.tool_name === "ExitPlanMode";
    const timeout = (isPlanReview ? (config.planTimeout ?? DEFAULT_CONFIG.planTimeout) : config.timeout) * 1000;
    response = await waitForResponse({
      server: config.ntfyServer,
      topic: config.topic,
      requestId,
      timeout,
      ...(auth && { auth }),
    });
  } catch (err) {
    console.error("[claude-remote-approver] Response listener failed:", err.message, "— Falling back to CLI.");
    return ASK;
  }

  if (response.timeout) {
    console.error("[claude-remote-approver] Timed out waiting for response. Falling back to CLI.");
    return ASK;
  }
  if (response.error) {
    console.error("[claude-remote-approver] Response error:", response.error.message, "— Falling back to CLI.");
    return ASK;
  }
  if (response.approved === false) return DENY;
  const decision = { behavior: "allow" };
  if (response.alwaysAllow === true && input.permission_suggestions?.length > 0) {
    decision.updatedPermissions = input.permission_suggestions;
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}
