import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CONFIG_PATH = path.join(os.homedir(), ".claude-remote-approver.json");

export const DEFAULT_CONFIG = {
  topic: "",
  ntfyServer: "https://ntfy.sh",
  timeout: 120,
  planTimeout: 300,
  // autoApprove/autoDeny are reserved for future use and not yet implemented
  autoApprove: [],
  autoDeny: [],
  ntfyUsername: "",
  ntfyPassword: "",
  title: "Claude Code",
};

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const fileConfig = JSON.parse(raw);
    const config = { ...DEFAULT_CONFIG, ...fileConfig };
    if (typeof config.topic !== "string") config.topic = DEFAULT_CONFIG.topic;
    if (typeof config.ntfyServer !== "string") config.ntfyServer = DEFAULT_CONFIG.ntfyServer;
    if (!Number.isFinite(config.timeout) || config.timeout <= 0) config.timeout = DEFAULT_CONFIG.timeout;
    if (!Number.isFinite(config.planTimeout) || config.planTimeout <= 0) config.planTimeout = DEFAULT_CONFIG.planTimeout;
    if (!Array.isArray(config.autoApprove)) config.autoApprove = DEFAULT_CONFIG.autoApprove;
    if (!Array.isArray(config.autoDeny)) config.autoDeny = DEFAULT_CONFIG.autoDeny;
    if (typeof config.ntfyUsername !== "string") config.ntfyUsername = DEFAULT_CONFIG.ntfyUsername;
    if (typeof config.ntfyPassword !== "string") config.ntfyPassword = DEFAULT_CONFIG.ntfyPassword;
    if (typeof config.title !== "string" || !config.title) config.title = DEFAULT_CONFIG.title;
    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
}

export function saveConfig(config, configPath = CONFIG_PATH) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function generateTopic() {
  return `cra-${crypto.randomBytes(16).toString("hex")}`;
}

export function resolveAuth(config, env = process.env) {
  const username = env.NTFY_USERNAME || config.ntfyUsername || "";
  const password = env.NTFY_PASSWORD || config.ntfyPassword || "";
  if (!username || !password) return null;
  return { username, password };
}
