# claude-remote-approver

Approve or deny Claude Code permission prompts from your phone.

---

## Problem

Claude Code asks for permission before running tools like `Bash`, `Write`, and `Edit`. These prompts require you to be sitting at your terminal. If you step away, Claude Code stalls until you come back and press "y".

**claude-remote-approver** sends each permission prompt as a push notification to your phone via [ntfy.sh](https://ntfy.sh). You tap **Approve** or **Deny**, and Claude Code continues immediately -- no terminal required.

## How it works

```
Claude Code
  │
  │  PermissionRequest hook (stdin JSON)
  ▼
cli.mjs hook
  │
  ├──POST──▶ ntfy.sh/<topic>          ──push──▶  Phone (ntfy app)
  │                                                 │
  │                                     Approve / Always Approve / Deny tap
  │                                                 │
  └──SSE───▶ ntfy.sh/<topic>-response  ◀──POST──┘
  │
  │  stdout JSON: allow / deny / ask (CLI fallback)
  ▼
Claude Code continues or stops
```

1. Claude Code invokes the hook, piping the tool request as JSON to stdin.
2. `cli.mjs hook` sends a notification to your ntfy topic with **Approve**, **Always Approve**, and **Deny** action buttons.
3. The hook subscribes to a response topic (`<topic>-response`) via server-sent events.
4. When you tap a button on your phone, ntfy.sh publishes your decision to the response topic.
5. The hook reads the decision and writes `{"behavior":"allow"}` or `{"behavior":"deny"}` to stdout. If the notification fails or times out, the hook returns `{"behavior":"ask"}` so Claude Code falls back to the CLI prompt.
6. Claude Code proceeds accordingly.

### AskUserQuestion support

When Claude Code calls the `AskUserQuestion` tool, the hook sends the question to your phone as a notification. Each option appears as an action button you can tap. If the question has more than 3 options, they are split across multiple notifications. If no response is received before the timeout, the hook falls back to the CLI prompt so you can answer at your terminal.

### Always Approve

When Claude Code sends a `permission_suggestions` field with the hook request (indicating the tool can be auto-approved in future), the notification shows three buttons: **Approve**, **Always Approve**, and **Deny**.

- **Approve** -- Allow this one request.
- **Always Approve** -- Allow this request and tell Claude Code to auto-approve this tool in future sessions. Claude Code adds the permission rule to its settings so it won't ask again.
- **Deny** -- Reject this request.

If the hook request does not include `permission_suggestions`, only the standard **Approve** and **Deny** buttons are shown.

## Quick Start

```bash
# 1. Install the ntfy app on your phone
#    iOS: https://apps.apple.com/app/ntfy/id1625396347
#    Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy

# 2. Install claude-remote-approver
npm install -g claude-remote-approver

# 3. Run setup
claude-remote-approver setup
```

Setup prints a QR code. Scan it with the ntfy app to subscribe, then **start a new Claude Code session**. The hook is loaded at session startup, so any session that was already running before installation will not have the hook active.

## Installation

```bash
npm install -g claude-remote-approver
```

Requires Node.js 18 or later.

## Setup

```bash
claude-remote-approver setup
```

This command does three things:

1. **Generates a unique topic** -- a random string like `cra-a1b2c3d4e5f6...` (128 bits of entropy).
2. **Creates a config file** at `~/.claude-remote-approver.json` with your topic and default settings. The file is created with permission `0600` (owner read/write only).
3. **Registers the hook** in Claude Code's `~/.claude/settings.json` under `hooks.PermissionRequest`. If a previous hook entry from this tool exists, it is replaced.

After running setup, scan the QR code displayed in the terminal with the ntfy app on your phone. You can also manually subscribe using the URL printed below the QR code.

## Usage

### `setup`

Configure the tool and register the hook with Claude Code.

```bash
claude-remote-approver setup
# Setup complete. Topic: cra-<hex>
#
# Scan this QR code in the ntfy app to subscribe:
#
# ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
# █ ▄▄▄▄▄ █ █ ▄▄▄▄▄ █
# ...
#
# Subscribe URL: https://ntfy.sh/cra-<hex>
```

### `test`

Send a test notification to verify your setup is working.

```bash
claude-remote-approver test
# Test notification sent successfully.
```

If you see the notification on your phone, everything is configured correctly.

### `status`

Display the current configuration.

```bash
claude-remote-approver status
# Topic:   cra-a1b2c3d4...
# Server:  https://ntfy.sh
# Timeout: 120s
# Auth:    not configured
```

### `enable`

Re-enable the hook after it has been disabled.

```bash
claude-remote-approver enable
# Hook enabled.
```

This reads the existing configuration and re-registers the hook in Claude Code's settings. You must have run `setup` at least once before using this command.

### `disable`

Temporarily disable the hook without removing your configuration.

```bash
claude-remote-approver disable
# Hook disabled. Run 'claude-remote-approver enable' to re-enable.
```

Your topic and settings are preserved. Use `enable` to re-activate.

### `uninstall`

Remove the hook and delete all configuration.

```bash
claude-remote-approver uninstall
# Uninstalled. Hook removed and configuration deleted.
```

This removes the hook entry from Claude Code's settings.json and deletes `~/.claude-remote-approver.json`. To use the tool again, run `setup`.

### `hook`

Internal command. Claude Code calls this automatically via the registered hook. It reads a JSON payload from stdin and writes a decision to stdout. You do not need to run this manually.

### Flags

```
--help, -h       Show usage information
--version, -v    Print version number
```

## Configuration

Config file location: `~/.claude-remote-approver.json`

```json
{
  "topic": "cra-a1b2c3d4e5f67890abcdef1234567890",
  "ntfyServer": "https://ntfy.sh",
  "timeout": 120,
  "planTimeout": 300,
  "autoApprove": [],
  "autoDeny": []
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `topic` | `string` | `""` | Your unique ntfy topic. Generated by `setup`. |
| `ntfyServer` | `string` | `"https://ntfy.sh"` | The ntfy server URL. Change this if you self-host. |
| `timeout` | `number` | `120` | Seconds to wait for a response before falling back to CLI. |
| `planTimeout` | `number` | `300` | Seconds to wait for ExitPlanMode (plan approval) responses. Plan reviews need more reading time. |
| `autoApprove` | `string[]` | `[]` | Reserved for future use. |
| `autoDeny` | `string[]` | `[]` | Reserved for future use. |
| `ntfyUsername` | `string` | `""` | Username for ntfy Basic Auth. Set this if your ntfy server requires authentication. |
| `ntfyPassword` | `string` | `""` | Password for ntfy Basic Auth. Set this if your ntfy server requires authentication. |
| `title` | `string` | `"Claude Code"` | Custom prefix for notification titles. Useful for distinguishing multiple instances (e.g. `"Claude (work)"`, `"Claude (personal)"`). |

### Using a self-hosted ntfy server

Edit `~/.claude-remote-approver.json` and set `ntfyServer` to your server URL:

```json
{
  "ntfyServer": "https://ntfy.example.com"
}
```

Then subscribe to the topic on your self-hosted server in the ntfy app.

### Using authenticated topics

If you are running a self-hosted ntfy server that requires authentication, you can configure Basic Auth credentials. If you are using the public ntfy.sh server, you do not need this — select "n" when prompted during setup.

**Option 1: Interactive setup**

```bash
claude-remote-approver setup
# ... after topic generation, you will be asked:
# Use authenticated topics? (only for self-hosted ntfy servers) (y/n): y
# Username: myuser
# Password: mypassword
```

**Option 2: Edit `~/.claude-remote-approver.json`**

```json
{
  "ntfyServer": "https://ntfy.example.com",
  "ntfyUsername": "myuser",
  "ntfyPassword": "mypassword"
}
```

**Option 3: Environment variables**

```bash
export NTFY_USERNAME=myuser
export NTFY_PASSWORD=mypassword
```

Environment variables take priority over settings.json values. Credentials are included as `Authorization: Basic <base64>` headers in all requests to the ntfy server, including action button callbacks.

## How ntfy.sh works

[ntfy.sh](https://ntfy.sh) is a simple HTTP-based pub-sub notification service. Any client can publish a message to a topic by sending a POST request, and any client subscribed to that topic receives the message as a push notification.

claude-remote-approver uses two topics:

- **`<topic>`** -- The hook publishes permission requests here. Your phone receives these as notifications with action buttons.
- **`<topic>-response`** -- When you tap Approve or Deny, the ntfy app sends an HTTP POST to this topic. The hook subscribes to it via SSE (server-sent events) and reads your decision.

No account is required. Topics are identified by name only, which is why the generated topic contains 128 bits of randomness.

For more details, see the [ntfy documentation](https://docs.ntfy.sh).

## Security

### Topic entropy

The topic name is generated using `crypto.randomBytes(16)`, producing 128 bits of randomness (32 hex characters). This makes the topic effectively unguessable.

### File permissions

The config file (`~/.claude-remote-approver.json`) is written with mode `0600` -- only the file owner can read or write it. This prevents other users on the system from reading your topic name.

### Self-hosting recommendation

The public ntfy.sh server is convenient but means your permission request details (tool names, commands, file paths) pass through a third-party server. For sensitive work, consider [self-hosting ntfy](https://docs.ntfy.sh/install/) and setting `ntfyServer` in your config to your own server.

### Timeout behavior

If no response is received within the configured timeout (default: 120 seconds), the hook falls back to the **CLI prompt** (`ask`), so you can still respond at your terminal.

## Disclaimer

**Use at your own risk.** This tool automates permission control for Claude Code. Misuse or misconfiguration may result in unintended code execution, file modification, or data loss.

The authors are not responsible for any damages or losses arising from the use of this tool, including but not limited to:

- Accidental approval of dangerous commands (e.g., mistapping Approve on your phone)
- Unintended CLI fallback when away from terminal (e.g., timeout, network issues)
- Security breaches if the topic name is compromised

**Not a substitute for careful review.** The push notification shows the tool name and a brief summary, but not the full context of what Claude Code is doing. Always review what you are approving.

This software is provided "AS IS" without warranty of any kind, as stated in the [MIT License](LICENSE).

## Requirements

- **Node.js** >= 18.0.0
- **ntfy app** on your phone
  - [iOS (App Store)](https://apps.apple.com/app/ntfy/id1625396347)
  - [Android (Google Play)](https://play.google.com/store/apps/details?id=io.heckel.ntfy)

## License

[MIT](LICENSE)