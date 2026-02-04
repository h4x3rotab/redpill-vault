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

**Important:** There is no `rv add` command. Use `rv import` to add secrets.

### Importing from .env

To populate the vault from a `.env` file:

```bash
rv import .env
```

This imports **all** keys from the `.env` file, stores each as a project-scoped secret in the vault, and registers it in `.rv.json`. Secret values go directly to the encrypted vault and never appear in stdout.

To import specific keys only: `rv import .env GITHUB_TOKEN DATABASE_URL`
To import as global keys: `rv import .env -g`

The user can also run `rv import .env` directly in their terminal to add new keys at any time.

### Editing .rv.json directly

To control which keys get injected, edit `.rv.json` directly. Each key in the `secrets` object will be injected as an env var:

```json
{
  "secrets": {
    "GITHUB_TOKEN": { "description": "GitHub API token" },
    "DATABASE_URL": {}
  }
}
```

### Setting or removing a single secret

The user can set or remove individual secrets in their terminal:

- `rv set KEY_NAME` — reads value from stdin, stores as project-scoped key
- `rv set KEY_NAME -g` — stores as global key
- `rv rm KEY_NAME` — removes the project-scoped key from vault
- `rv rm KEY_NAME -g` — removes the global key from vault

These commands only affect the vault — they do not modify `.rv.json`. The agent is blocked from running `rv set` and `rv rm`.

### When secrets are missing

If `rv list` shows `[missing]` for a key, tell the user to run one of these in their terminal:

- `rv import .env` — to bulk-import from an env file
- `rv set KEY_NAME` — to set a single key (reads value from stdin)

## How it works

Once approved, every Bash command the agent runs is automatically wrapped with `rv-exec`, which injects the secrets listed in `.rv.json` as environment variables. The agent never sees the secret values — they are resolved at execution time by `rv-exec` from the encrypted vault.

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
| `rv import .env` | agent or user | Import all secrets from a .env file into vault |
| `rv import .env -g` | agent or user | Import as global keys |
| `rv list` | agent or user | Show secrets with source (`[project]`/`[global]`/`[missing]`) |
| `rv list -g` | agent or user | Show only global keys in vault |
| `rv check` | agent or user | Verify all keys exist in vault |
| `rv doctor` | agent or user | Full health check |
| `rv set KEY` | **user only** | Set a single secret (reads value from stdin) |
| `rv rm KEY` | **user only** | Remove a secret from vault |
| `rv approve` | **user only** | Approve this project for injection |
| `rv revoke` | **user only** | Revoke project approval |
