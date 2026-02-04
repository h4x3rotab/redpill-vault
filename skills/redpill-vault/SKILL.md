---
name: redpill-vault
description: Manages all environment variables and credentials for AI tools. API keys, tokens, database URLs, and other secrets are stored in a vault and injected transparently into shell commands via a PreToolUse hook — the agent never sees secret values or the master key. Supports project-scoped and global credentials. Use this skill whenever you need to add, list, configure, or troubleshoot env vars, secrets, or credentials.
---

# redpill-vault

Secure credential manager for AI tools. Secrets are injected transparently into shell commands — the agent never sees secret values or the master key.

## Setup

Run these commands in order. Step 1 installs the CLI — always run it first, even if `rv` appears missing.

```bash
./skills/redpill-vault/setup.sh
```

```bash
rv init
```

Then tell the user to run `rv approve` in their terminal. Only the user can approve — the hook blocks the agent from running this command.

## Adding secrets

Secrets are project-scoped by default. The project name comes from the `"project"` field in `.rv.json`, or the directory name if not set.

```bash
# Project-scoped (stored as MYPROJECT__MY_SECRET in vault)
rv add MY_SECRET -d "API key for the foobar service"

# Global (shared across all projects)
rv add MY_SECRET -g -d "API key for the foobar service"
```

Then the user sets the value in the vault. The hint from `rv add` shows the exact key name to use:

```bash
# Project-scoped key
psst --global set MYPROJECT__MY_SECRET

# Global key
psst --global set MY_SECRET
```

## How it works

Once approved, every Bash command the agent runs is automatically wrapped with `rv-exec`, which injects the secrets listed in `.rv.json` as environment variables. The agent never sees the secret values — they are resolved at execution time by `rv-exec` using the psst vault.

**Project-scoped fallback:** For each key, `rv-exec` checks for a project-scoped key (`PROJECT__KEY`) first, then falls back to the global key (`KEY`). This means a project can override global credentials or inherit them without any extra config.

**Listing secrets:** `rv list` shows each key's source — `[project]`, `[global]`, or `[missing]`.

## .rv.json

```json
{
  "project": "myapp",
  "secrets": {
    "GITHUB_TOKEN": { "description": "GitHub API token" },
    "DATABASE_URL": { "description": "Postgres connection" }
  }
}
```

The `"project"` field is optional. If omitted, the directory name is used.

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `rv init` | agent or user | Full setup (master key + vault + config + hook) |
| `rv add <KEY>` | agent or user | Register a secret (project-scoped by default) |
| `rv add <KEY> -g` | agent or user | Register a global secret |
| `rv remove <KEY>` | agent or user | Remove a secret from `.rv.json` |
| `rv remove <KEY> --vault` | agent or user | Also remove from vault |
| `rv list` | agent or user | Show secrets with source (`[project]`/`[global]`/`[missing]`) |
| `rv list -g` | agent or user | Show only global keys in vault |
| `rv check` | agent or user | Verify all keys exist in vault |
| `rv doctor` | agent or user | Full health check |
| `rv approve` | **user only** | Approve this project for injection |
| `rv revoke` | **user only** | Revoke project approval |
