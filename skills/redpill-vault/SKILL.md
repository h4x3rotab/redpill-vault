---
name: redpill-vault
description: Secure credential manager for AI tools. Secrets are injected transparently into shell commands via a PreToolUse hook — the agent never sees secret values or the master key. Trigger phrases include "add a secret", "inject credentials", "set up vault", "rv init", "rv add", or any secret/credential management request.
---

# redpill-vault

Secure credential manager for AI tools. Secrets are injected transparently into shell commands — the agent never sees secret values or the master key.

## Setup

Run this first (works before approval — `rv` commands are always allowed through the hook):

```bash
rv init
```

Then tell the user to run `rv approve` in their terminal. Only the user can approve — the hook blocks the agent from running this command.

**Note:** The plugin hook auto-installs `redpill-vault` on first use. If `rv` is not found, run any bash command first to trigger the hook, then retry `rv init`.

## Adding secrets

```bash
rv add MY_SECRET -d "API key for the foobar service"
```

Then the user sets the value in the vault:

```bash
psst set MY_SECRET --global
```

## How it works

Once approved, every Bash command the agent runs is automatically wrapped with `rv-exec`, which injects the secrets listed in `.rv.json` as environment variables. The agent never sees the secret values — they are resolved at execution time by `rv-exec` using the psst vault.

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `rv init` | agent or user | Full setup (master key + vault + config + hook) |
| `rv add <KEY>` | agent or user | Register a secret in `.rv.json` |
| `rv remove <KEY>` | agent or user | Remove a secret from `.rv.json` |
| `rv list` | agent or user | Show configured secrets |
| `rv check` | agent or user | Verify all keys exist in vault |
| `rv doctor` | agent or user | Full health check |
| `rv approve` | **user only** | Approve this project for injection |
| `rv revoke` | **user only** | Revoke project approval |
