// src/ntfy.mjs

export function buildAuthHeader(auth) {
  if (!auth) return {};
  return { Authorization: `Basic ${Buffer.from(auth.username + ':' + auth.password).toString('base64')}` };
}

/**
 * Send a push notification via ntfy.
 *
 * @param {{ server: string, topic: string, title: string, message: string, actions: unknown[], requestId: string }} params
 * @returns {Promise<Response>}
 */
export async function sendNotification({ server, topic, title, message, actions, requestId, auth }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = baseUrl;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeader(auth) },
    body: JSON.stringify({ topic, title, message, actions }),
  });

  if (!response.ok) {
    throw new Error(`ntfy notification failed: HTTP ${response.status}`);
  }

  return response;
}

/**
 * Subscribe to the response topic via SSE and wait for a matching requestId.
 *
 * @param {{ server: string, topic: string, requestId: string, timeout: number }} params
 * @returns {Promise<{ approved: boolean } | { timeout: true } | { error: Error } | { answer: string }>}
 */
export async function waitForResponse({ server, topic, requestId, timeout, auth }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = `${baseUrl}/${topic}-response/json`;

  const controller = new AbortController();

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  try {
    const authHeaders = auth ? buildAuthHeader(auth) : undefined;
    const response = await fetch(url, { signal: controller.signal, ...(authHeaders && { headers: authHeaders }) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Listen to abort so we can cancel the reader even when the mock stream
    // never closes (the real fetch would propagate the signal, but mocks may not).
    const onAbort = () => reader.cancel();
    controller.signal.addEventListener('abort', onAbort);

    // Start the timeout AFTER fetch resolves so we measure waiting time only.
    timer = setTimeout(() => controller.abort(), timeout);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const parsed = JSON.parse(event.message);
            if (parsed.requestId === requestId) {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', onAbort);
              controller.abort();
              if (typeof parsed.answer === 'string') {
                return { answer: parsed.answer };
              }
              return { approved: parsed.approved, alwaysAllow: parsed.alwaysAllow === true };
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }

    clearTimeout(timer);
    return { timeout: true };
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    if (err?.name === "AbortError") {
      return { timeout: true };
    }
    console.error("[claude-remote-approver] waitForResponse error:", err.message ?? err);
    return { error: err };
  }
}

/**
 * Strip markdown formatting from text, returning plain text.
 *
 * @param {string} text - Markdown text to strip
 * @returns {string} Plain text with markdown removed
 */
export function stripMarkdown(text) {
  // Input guard
  if (text.length > MAX_INPUT) {
    text = text.slice(0, MAX_INPUT);
  }

  // Order matters: fenced code blocks must be first to prevent processing markdown inside them.
  let result = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')                // Fenced code blocks
    .replace(/^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '') // Horizontal rules (before list markers)
    .replace(/^#{1,6}\s+/gm, '')                          // Headers
    .replace(/^(?:>[ \t]?)+/gm, '')                       // Block quotes
    .replace(/^[ \t]*[-*+] /gm, '')                       // Unordered list markers with indent
    .replace(/^[ \t]*\d+\. /gm, '');                      // Ordered list markers with indent

  result = stripInline(result);

  return result.replace(/\n{2,}/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const MAX_INPUT = 10000;
const MESSAGE_MAX_LENGTH = 1000;

/**
 * Count consecutive runs of character ch starting at pos.
 *
 * @param {string} text
 * @param {number} pos
 * @param {string} ch
 * @returns {number}
 */
function countRun(text, pos, ch) {
  let count = 0;
  while (pos + count < text.length && text[pos + count] === ch) count++;
  return count;
}

const RE_ALPHANUMERIC = /[a-zA-Z0-9]/;
const RE_WHITESPACE = /\s/;
const RE_ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isAlphanumeric(ch) { return RE_ALPHANUMERIC.test(ch); }

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isWhitespace(ch) { return RE_WHITESPACE.test(ch); }

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isAsciiPunctuation(ch) { return RE_ASCII_PUNCTUATION.test(ch); }

/**
 * Precompute matched bracket/paren pairs using a stack in O(n).
 * Skips backslash-escaped characters so that \[ \] \( \) don't create false pairs.
 * Returns a Map from opening index to closing index.
 *
 * @param {string} str
 * @param {string} open
 * @param {string} close
 * @returns {Map<number, number>}
 */
function precomputePairs(str, open, close) {
  const pairs = new Map();
  const stack = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length && isAsciiPunctuation(str[i + 1])) {
      i += 2;
      continue;
    }
    // Skip code spans — brackets inside are literal
    if (str[i] === '`') {
      const tickCount = countRun(str, i, '`');
      const closeIdx = findBacktickCloser(str, tickCount, i + tickCount);
      if (closeIdx !== -1) {
        i = closeIdx + tickCount;
        continue;
      }
      i += tickCount;
      continue;
    }
    if (str[i] === open) stack.push(i);
    else if (str[i] === close && stack.length > 0) {
      pairs.set(stack.pop(), i);
    }
    i++;
  }
  return pairs;
}

/**
 * Find exactly tickCount consecutive backticks (not more, not less).
 * CommonMark: backslash inside code spans is literal, so no escape skipping.
 *
 * @param {string} text
 * @param {number} tickCount
 * @param {number} start
 * @returns {number}
 */
function findBacktickCloser(text, tickCount, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') {
      const run = countRun(text, i, '`');
      if (run === tickCount) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find a closing ~~ for strikethrough, skipping backslash-escaped characters.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findStrikethroughCloser(text, start) {
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === '\\' && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] === '~' && text[i + 1] === '~') return i;
    i++;
  }
  return -1;
}

/**
 * Find a closer for emphasis marker ch with at least markerLen consecutive chars.
 * Skips \* and \_ (escaped markers).
 * Closer condition: run >= markerLen AND preceding char is not whitespace.
 *
 * @param {string} text
 * @param {string} ch
 * @param {number} markerLen
 * @param {number} start
 * @returns {number}
 */
function findEmphasisCloser(text, ch, markerLen, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] === ch) {
      const run = countRun(text, i, ch);
      if (run >= markerLen && i > 0 && !isWhitespace(text[i - 1])) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Handle emphasis markers (* or _).
 * Returns { output, nextPos } on success, or null if the run should be treated as literal.
 *
 * @param {string} text
 * @param {number} pos
 * @returns {{ output: string, nextPos: number } | null}
 */
function handleEmphasis(text, pos) {
  const ch = text[pos];

  // Count run length
  const runLen = countRun(text, pos, ch);

  // Opener condition:
  //   - prevChar is NOT alphanumeric (or start of string)
  //   - char after the run is NOT whitespace and not end of string
  const prevChar = pos > 0 ? text[pos - 1] : '';
  const afterIdx = pos + runLen;
  const afterChar = afterIdx < text.length ? text[afterIdx] : '';

  const isOpener = !isAlphanumeric(prevChar) && afterChar !== '' && !isWhitespace(afterChar);

  if (!isOpener) return null;

  // Try matching closest, longest-first (min(runLen, 3) down to 1)
  const maxMarker = Math.min(runLen, 3);
  // NOTE: O(n²) worst case when many openers lack closers (k openers × O(n) scan).
  // Bounded by MAX_INPUT=10000; measured ~163ms worst case. Acceptable for notification text.
  for (let markerLen = maxMarker; markerLen >= 1; markerLen--) {
    let searchFrom = pos + runLen;
    while (true) {
      const idx = findEmphasisCloser(text, ch, markerLen, searchFrom);
      if (idx === -1) break; // no closer found for this markerLen
      const content = text.slice(pos + markerLen, idx);
      if (content.length === 0) {
        // Empty emphasis — skip this closer and keep searching
        searchFrom = idx + countRun(text, idx, ch);
        continue;
      }
      return { output: stripInline(content), nextPos: idx + markerLen };
    }
  }

  return null;
}

/**
 * Strip inline markdown formatting by scanning character by character.
 *
 * @param {string} text
 * @returns {string}
 */
function stripInline(text) {
  // NOTE: Recursive calls for emphasis/strikethrough/link content.
  // Depth bounded by nesting level (shallow in real-world markdown).
  const bracketPairs = precomputePairs(text, '[', ']');
  const parenPairs = precomputePairs(text, '(', ')');

  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const tickCount = countRun(text, i, '`');
      const closeIdx = findBacktickCloser(text, tickCount, i + tickCount);
      if (closeIdx !== -1) {
        out += text.slice(i + tickCount, closeIdx);
        i = closeIdx + tickCount;
        continue;
      }
      // Unclosed backtick(s) — output as literal
      out += text.slice(i, i + tickCount);
      i += tickCount;
      continue;
    }

    if (ch === '!' && i + 1 < text.length && text[i + 1] === '[') {
      const closeBracket = bracketPairs.get(i + 1);
      if (closeBracket !== undefined && closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
        const closeParen = parenPairs.get(closeBracket + 1);
        if (closeParen !== undefined) {
          const altText = text.slice(i + 2, closeBracket);
          out += stripInline(altText);
          i = closeParen + 1;
          continue;
        }
      }
      // Not a valid image — output ! as literal
      out += ch;
      i++;
      continue;
    }

    if (ch === '[') {
      const closeBracket = bracketPairs.get(i);
      if (closeBracket !== undefined && closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
        const closeParen = parenPairs.get(closeBracket + 1);
        if (closeParen !== undefined) {
          const linkText = text.slice(i + 1, closeBracket);
          out += stripInline(linkText);
          i = closeParen + 1;
          continue;
        }
      }
      // Not a valid link — output as literal
      out += ch;
      i++;
      continue;
    }

    if (ch === '~' && i + 1 < text.length && text[i + 1] === '~') {
      const searchStart = i + 2;
      const closeIdx = findStrikethroughCloser(text, searchStart);
      if (closeIdx !== -1) {
        const content = text.slice(searchStart, closeIdx);
        if (content.length === 0) {
          out += '~~';
          i += 2;
          continue;
        }
        out += stripInline(content);
        i = closeIdx + 2;
        continue;
      }
      // No closer — output ~~ as literal
      out += '~~';
      i += 2;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const result = handleEmphasis(text, i);
      if (result !== null) {
        out += result.output;
        i = result.nextPos;
        continue;
      }
      // Not an opener or no closer — output entire run as literal
      const runLen = countRun(text, i, ch);
      out += text.slice(i, i + runLen);
      i += runLen;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Format tool information for display in the notification.
 *
 * @param {{ hook_event_name: string, tool_name: string, tool_input: Record<string, unknown> }} params
 * @param {{ titlePrefix: string }} [options]
 * @returns {{ title: string, message: string }}
 */
export function formatToolInfo({ hook_event_name, tool_name, tool_input }, { titlePrefix } = {}) {
  const prefix = titlePrefix ?? 'Claude Code';
  let title;
  let message;

  if (tool_name === 'ExitPlanMode' && typeof tool_input?.plan === 'string') {
    title = `${prefix}: Plan Review`;
    const plain = tool_input.plan.trim() ? stripMarkdown(tool_input.plan) : '';
    message = plain || '(empty plan)';
  } else {
    title = `${prefix}: ${tool_name}`;
    switch (tool_name) {
      case 'Bash':
        message = tool_input?.command ?? JSON.stringify(tool_input);
        break;
      case 'Read':
      case 'Write':
      case 'Edit':
        message = tool_input?.file_path ?? JSON.stringify(tool_input);
        break;
      default:
        message = JSON.stringify(tool_input);
        break;
    }
  }

  if (message.length > MESSAGE_MAX_LENGTH) {
    message = message.slice(0, MESSAGE_MAX_LENGTH) + '...';
  }
  return { title, message };
}
