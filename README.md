# redpill-vault

Redpill-vault is a secure credential manager for all your AI tools. It stores your API keys and context safely, so you never re-enter them between sessions, and they never touch LLM chats.

Your keys are encrypted and sync privately across your devices. Stop pasting keys. Start coding.

## Requirements

- Node.js
- `psst` (installed automatically and exposed on PATH by this package)

## Install

```bash
npm i -g redpill-vault
```

## Quick start

```bash
# 1) Initialize vault + hook in your project
rv init

# 2) Register which secrets this repo is allowed to use
rv add OPENAI_API_KEY

# 3) Store the secret in psst (global vault)
psst --global set OPENAI_API_KEY

# 4) Approve this project for injection
rv approve
```

After approval, any Bash command run by the agent is wrapped with `rv-exec`, and the secrets listed in `.rv.json` are injected as environment variables.

## Claude Code plugin

Install the plugin marketplace and plugin:

```bash
claude plugin marketplace add https://github.com/h4x3rotab/redpill-vault
claude plugin install redpill-vault@redpill-vault-marketplace
```

Then ask Claude to run the skill:

```
Use the redpill-vault skill to set up redpill-vault for this project.
```

Claude will run `rv init`. You still need to run `rv approve` yourself.

## Common commands

```bash
rv add <KEY>        # add key to .rv.json
rv remove <KEY>     # remove key from .rv.json
rv list             # list keys in .rv.json
rv approve          # allow this project to inject its secrets
rv revoke           # remove approval
rv check            # verify keys exist in psst
rv doctor           # full health check
```

## Notes

- Secrets are injected per-project based on `.rv.json` and approval state.
- The agent never sees secret values; `rv-exec` resolves them at execution time via `psst`.
