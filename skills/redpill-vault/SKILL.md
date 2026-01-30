---
name: redpill-vault
description: Secure credential manager for AI tools. Secrets are injected transparently into shell commands via a PreToolUse hook — the agent never sees secret values or the master key. Trigger phrases include "add a secret", "inject credentials", "set up vault", "rv init", "rv add", or any secret/credential management request.
---

# redpill-vault

Secure credential manager for AI tools. Secrets are injected transparently into shell commands via a PreToolUse hook — the agent never sees secret values or the master key.

## First-time project setup

Run `rv init` in the project root. This will:
- Create a master key (if not already present)
- Initialize the psst vault (if not already present)
- Create `.rv.json` in the current directory
- Wire the `rv-hook` into `.claude/settings.json`

**Note:** `rv init` and `rv approve` must be run by the user, not the agent. The hook blocks the agent from running these commands.

## Adding secrets

```bash
rv add MY_SECRET -d "API key for the foobar service"
psst set MY_SECRET --global
```

Then approve the project:

```bash
rv approve
```

## How it works

Once approved, every Bash command the agent runs is automatically wrapped with `rv-exec`, which injects the secrets listed in `.rv.json` as environment variables. The agent never sees the secret values — they are resolved at execution time by `rv-exec` using the psst vault.

## Commands

| Command | Description |
|---------|-------------|
| `rv init` | Full setup (master key + vault + config + hook) |
| `rv add <KEY>` | Register a secret in `.rv.json` |
| `rv remove <KEY>` | Remove a secret from `.rv.json` |
| `rv list` | Show configured secrets |
| `rv approve` | Approve this project for injection |
| `rv revoke` | Revoke project approval |
| `rv check` | Verify all keys exist in vault |
| `rv doctor` | Full health check |
