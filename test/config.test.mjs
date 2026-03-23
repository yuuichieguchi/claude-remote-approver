/**
 * Test module for config.mjs
 *
 * Coverage:
 * - CONFIG_PATH uses home directory
 * - DEFAULT_CONFIG has correct shape and values
 * - loadConfig returns defaults when no file exists
 * - loadConfig merges partial config with defaults
 * - saveConfig writes valid JSON and loadConfig reads it back (round-trip)
 * - generateTopic returns string matching /^cra-[a-f0-9]{32}$/
 * - saveConfig writes file with mode 0o600
 * - loadConfig validates types and falls back to defaults for invalid values
 * - resolveAuth returns credentials from env or config
 * - resolveAuth returns null when credentials are incomplete
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  generateTopic,
  resolveAuth,
} from "../src/config.mjs";

// ==================== CONFIG_PATH ====================

describe("CONFIG_PATH", () => {
  it("should be a string ending with .claude-remote-approver.json", () => {
    assert.equal(typeof CONFIG_PATH, "string");
    assert.ok(
      CONFIG_PATH.endsWith(".claude-remote-approver.json"),
      `CONFIG_PATH should end with .claude-remote-approver.json, got: ${CONFIG_PATH}`
    );
  });

  it("should be located in the user home directory", () => {
    const home = os.homedir();
    assert.equal(
      CONFIG_PATH,
      path.join(home, ".claude-remote-approver.json"),
      `CONFIG_PATH should be ${path.join(home, ".claude-remote-approver.json")}, got: ${CONFIG_PATH}`
    );
  });
});

// ==================== DEFAULT_CONFIG ====================

describe("DEFAULT_CONFIG", () => {
  it("should be a plain object", () => {
    assert.equal(typeof DEFAULT_CONFIG, "object");
    assert.ok(DEFAULT_CONFIG !== null, "DEFAULT_CONFIG should not be null");
    assert.ok(!Array.isArray(DEFAULT_CONFIG), "DEFAULT_CONFIG should not be an array");
  });

  it("should have topic as empty string", () => {
    assert.equal(DEFAULT_CONFIG.topic, "");
  });

  it("should have ntfyServer as https://ntfy.sh", () => {
    assert.equal(DEFAULT_CONFIG.ntfyServer, "https://ntfy.sh");
  });

  it("should have timeout as 120", () => {
    assert.equal(DEFAULT_CONFIG.timeout, 120);
  });

  it("should have autoApprove as an empty array", () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.autoApprove), "autoApprove should be an array");
    assert.equal(DEFAULT_CONFIG.autoApprove.length, 0);
  });

  it("should have autoDeny as an empty array", () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.autoDeny), "autoDeny should be an array");
    assert.equal(DEFAULT_CONFIG.autoDeny.length, 0);
  });

  it("should have planTimeout as 300", () => {
    assert.equal(DEFAULT_CONFIG.planTimeout, 300);
  });

  it("should have ntfyUsername as empty string", () => {
    assert.equal(DEFAULT_CONFIG.ntfyUsername, "");
  });

  it("should have ntfyPassword as empty string", () => {
    assert.equal(DEFAULT_CONFIG.ntfyPassword, "");
  });

  it("should have title as 'Claude Code'", () => {
    assert.equal(DEFAULT_CONFIG.title, "Claude Code");
  });
});

// ==================== loadConfig ====================

describe("loadConfig", () => {
  /** Use a temp directory to isolate filesystem tests. */
  let tmpDir;
  let tmpConfigPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-test-"));
    tmpConfigPath = path.join(tmpDir, ".claude-remote-approver.json");
  });

  after(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof loadConfig, "function");
  });

  it("should return defaults when config file does not exist", () => {
    const nonExistentPath = path.join(tmpDir, "no-such-file.json");
    const config = loadConfig(nonExistentPath);

    assert.deepEqual(config, {
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      planTimeout: 300,
      autoApprove: [],
      autoDeny: [],
      ntfyUsername: "",
      ntfyPassword: "",
      title: "Claude Code",
    });
  });

  it("should merge partial config with defaults", () => {
    const partialConfig = { topic: "my-topic", timeout: 60 };
    fs.writeFileSync(tmpConfigPath, JSON.stringify(partialConfig, null, 2));

    const config = loadConfig(tmpConfigPath);

    // Overridden values
    assert.equal(config.topic, "my-topic");
    assert.equal(config.timeout, 60);

    // Default values preserved
    assert.equal(config.ntfyServer, "https://ntfy.sh");
    assert.deepEqual(config.autoApprove, []);
    assert.deepEqual(config.autoDeny, []);
  });

  it("should return a full config when file contains all fields", () => {
    const fullConfig = {
      topic: "full-topic",
      ntfyServer: "https://custom.ntfy.example.com",
      timeout: 300,
      planTimeout: 600,
      autoApprove: ["Bash(*)"],
      autoDeny: ["mcp__*"],
      ntfyUsername: "",
      ntfyPassword: "",
      title: "My Claude",
    };
    fs.writeFileSync(tmpConfigPath, JSON.stringify(fullConfig, null, 2));

    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config, fullConfig);
  });

  it("should fall back to default topic when topic is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ topic: 123 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.topic, DEFAULT_CONFIG.topic);
  });

  it("should fall back to default ntfyServer when ntfyServer is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ ntfyServer: null }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.ntfyServer, DEFAULT_CONFIG.ntfyServer);
  });

  it("should fall back to default timeout when timeout is not a positive number", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: "fast" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);
  });

  it("should fall back to default timeout when timeout is zero or negative", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: 0 }));
    let config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);

    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: -10 }));
    config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);
  });

  it("should fall back to default autoApprove when autoApprove is not an array", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ autoApprove: "Bash(*)" }));
    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config.autoApprove, DEFAULT_CONFIG.autoApprove);
  });

  it("should fall back to default autoDeny when autoDeny is not an array", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ autoDeny: true }));
    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config.autoDeny, DEFAULT_CONFIG.autoDeny);
  });

  it("should fall back to default planTimeout when planTimeout is not a positive number", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: "slow" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);
  });

  it("should fall back to default planTimeout when planTimeout is zero or negative", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: 0 }));
    let config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);

    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: -5 }));
    config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);
  });

  it("should accept valid planTimeout from config file", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: 600 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, 600);
  });

  it("should fall back to default ntfyUsername when ntfyUsername is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ ntfyUsername: 123 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.ntfyUsername, DEFAULT_CONFIG.ntfyUsername);
  });

  it("should fall back to default ntfyPassword when ntfyPassword is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ ntfyPassword: true }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.ntfyPassword, DEFAULT_CONFIG.ntfyPassword);
  });

  it("should fall back to default title when title is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ title: 42 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.title, DEFAULT_CONFIG.title);
  });

  it("should fall back to default title when title is empty string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ title: "" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.title, DEFAULT_CONFIG.title);
  });

  it("should accept a custom title string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ title: "My Claude" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.title, "My Claude");
  });
});

// ==================== saveConfig ====================

describe("saveConfig", () => {
  let tmpDir;
  let tmpConfigPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-test-"));
    tmpConfigPath = path.join(tmpDir, ".claude-remote-approver.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof saveConfig, "function");
  });

  it("should write valid JSON to the specified path", () => {
    const config = {
      topic: "save-test",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };

    saveConfig(config, tmpConfigPath);

    const raw = fs.readFileSync(tmpConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, config);
  });

  it("should write JSON with 2-space indentation", () => {
    const config = { topic: "indent-test", ntfyServer: "https://ntfy.sh" };

    saveConfig(config, tmpConfigPath);

    const raw = fs.readFileSync(tmpConfigPath, "utf-8");
    const expected = JSON.stringify(config, null, 2);
    assert.equal(raw, expected);
  });

  it("should round-trip with loadConfig", () => {
    const original = {
      topic: "roundtrip",
      ntfyServer: "https://custom.example.com",
      timeout: 90,
      planTimeout: 180,
      autoApprove: ["Read"],
      autoDeny: ["Bash(rm*)"],
      ntfyUsername: "",
      ntfyPassword: "",
      title: "Claude Code",
    };

    saveConfig(original, tmpConfigPath);
    const loaded = loadConfig(tmpConfigPath);

    assert.deepEqual(loaded, original);
  });

  it("should write file with mode 0o600 (owner read/write only)", () => {
    const config = { topic: "perm-test" };
    saveConfig(config, tmpConfigPath);

    const stat = fs.statSync(tmpConfigPath);
    const mode = stat.mode & 0o777;
    assert.equal(
      mode,
      0o600,
      `File mode should be 0o600, got 0o${mode.toString(8)}`
    );
  });
});

// ==================== generateTopic ====================

describe("generateTopic", () => {
  it("should be a function", () => {
    assert.equal(typeof generateTopic, "function");
  });

  it("should return a string", () => {
    const topic = generateTopic();
    assert.equal(typeof topic, "string");
  });

  it("should start with 'cra-' prefix", () => {
    const topic = generateTopic();
    assert.ok(topic.startsWith("cra-"), `Topic should start with 'cra-', got: ${topic}`);
  });

  it("should match pattern /^cra-[a-f0-9]{32}$/", () => {
    const topic = generateTopic();
    const pattern = /^cra-[a-f0-9]{32}$/;
    assert.match(topic, pattern, `Topic should match ${pattern}, got: ${topic}`);
  });

  it("should generate unique values on successive calls", () => {
    const topics = new Set();
    for (let i = 0; i < 20; i++) {
      topics.add(generateTopic());
    }
    assert.equal(topics.size, 20, "All 20 generated topics should be unique");
  });
});

// ==================== resolveAuth ====================

describe("resolveAuth", () => {
  it("should be a function", () => {
    assert.equal(typeof resolveAuth, "function");
  });

  it("should return { username, password } when env vars NTFY_USERNAME and NTFY_PASSWORD are set", () => {
    const env = { NTFY_USERNAME: "user1", NTFY_PASSWORD: "pass1" };
    const result = resolveAuth({}, env);
    assert.deepEqual(result, { username: "user1", password: "pass1" });
  });

  it("should return { username, password } from config when env vars are not set", () => {
    const config = { ntfyUsername: "confuser", ntfyPassword: "confpass" };
    const env = {};
    const result = resolveAuth(config, env);
    assert.deepEqual(result, { username: "confuser", password: "confpass" });
  });

  it("should prioritize env vars over config values", () => {
    const config = { ntfyUsername: "confuser", ntfyPassword: "confpass" };
    const env = { NTFY_USERNAME: "envuser", NTFY_PASSWORD: "envpass" };
    const result = resolveAuth(config, env);
    assert.deepEqual(result, { username: "envuser", password: "envpass" });
  });

  it("should return null when both username and password are empty strings", () => {
    const config = { ntfyUsername: "", ntfyPassword: "" };
    const env = {};
    const result = resolveAuth(config, env);
    assert.equal(result, null);
  });

  it("should return null when only username is set (no password)", () => {
    const config = { ntfyUsername: "user-only", ntfyPassword: "" };
    const env = {};
    const result = resolveAuth(config, env);
    assert.equal(result, null);
  });

  it("should return null when only password is set (no username)", () => {
    const config = { ntfyUsername: "", ntfyPassword: "pass-only" };
    const env = {};
    const result = resolveAuth(config, env);
    assert.equal(result, null);
  });

  it("should accept a single argument using process.env as default", () => {
    // Verify the function can be called with just one argument (config)
    // without throwing a TypeError about missing parameters.
    assert.equal(resolveAuth.length >= 1, true);
    // Call with one arg — should not throw
    assert.doesNotThrow(() => resolveAuth({}));
  });
});
