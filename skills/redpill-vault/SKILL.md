---
name: redpill-vault
description: Manages environment variables and credentials for AI tools. API keys, tokens, database URLs, and other secrets are stored in an encrypted vault. Use rv-exec to run commands with secrets injected. The agent never sees secret values or the master key.
---

# redpill-vault

Secure credential manager for AI tools. Secrets are stored in an encrypted vault and injected into commands via `rv-exec`.

## NEVER run these commands

The following commands are **user-only** — the agent must NEVER run them:

- `rv approve` — only the user can approve a project
- `rv revoke` — only the user can revoke approval
- `rv set` — only the user can set secret values

If a secret is missing, tell the user to run `rv set KEY_NAME` themselves.

## Setup

```bash
./skills/redpill-vault/setup.sh
```

```bash
rv init
```

After setup, the **user** must approve the project before secrets can be injected:

```bash
rv approve
```

This is a one-time step per project. The agent cannot run `rv approve` — only the user can.

## Running commands with secrets

Use `rv-exec --all` to inject all secrets from `.rv.json`:

```bash
rv-exec --all -- <command>
```

Examples:
```bash
rv-exec --all -- npm run deploy
rv-exec --all -- docker push myimage:latest
rv-exec --all -- bash -c 'echo $MY_SECRET'
```

The `--all` flag injects all secrets defined in `.rv.json`. Secrets are resolved from the vault at runtime — the agent never sees the values.

### Specific keys

To inject only specific keys:
```bash
rv-exec KEY1 KEY2 -- <command>
```

### Generating a .env file

Some commands require a `.env` file. Use `--dotenv`:

```bash
rv-exec --all --dotenv .env -- phala deploy -e .env
```

This writes secrets to `.env` before running and deletes it after.

## Adding secrets

### Importing from .env

```bash
rv import .env
```

Imports all keys from the file, stores each as a project-scoped secret. Values go directly to the encrypted vault.

To import specific keys: `rv import .env GITHUB_TOKEN DATABASE_URL`
To import as global keys: `rv import .env -g`

### Setting a single secret (user only)

Tell the user to run in their terminal:
```bash
rv set KEY_NAME
```

The agent must NEVER run `rv set` — it reads secret values from stdin.

### Removing secrets

```bash
rv rm KEY_NAME
rv rm KEY_NAME -g  # global
```

## .rv.json

```json
{
  "project": "myapp",
  "secrets": {
    "GITHUB_TOKEN": { "description": "GitHub API token" },
    "DATABASE_URL": {}
  }
}
```

The `"project"` field is optional — directory name is used if omitted.

## Key resolution

For each key, `rv-exec` checks:
1. Project-scoped key (`PROJECT__KEY`) first
2. Falls back to global key (`KEY`)

This lets projects override or inherit global credentials.

`rv list` shows each key's source: `[project]`, `[global]`, or `[missing]`.

## Commands

| Command | Description |
|---------|-------------|
| `rv init` | Initialize project (master key + vault + config) |
| `rv approve` | Approve project for secret injection (user only) |
| `rv revoke` | Revoke project approval (user only) |
| `rv import .env` | Import secrets from .env file |
| `rv list` | Show secrets with source |
| `rv list -g` | Show global keys in vault |
| `rv check` | Verify all keys exist |
| `rv doctor` | Full health check |
| `rv set KEY` | Set a secret (user only, reads from stdin) |
| `rv rm KEY` | Remove a secret |
| `rv-exec --all -- cmd` | Run command with all secrets |
| `rv-exec K1 K2 -- cmd` | Run command with specific secrets |
