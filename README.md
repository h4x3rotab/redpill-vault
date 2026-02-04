# redpill-vault

Redpill-vault is a secure credential manager for all your AI tools. It stores your API keys and context safely, so you never re-enter them between sessions, and they never touch LLM chats.

Your keys are encrypted and sync privately across your devices. Stop pasting keys. Start coding.

## Requirements

- Node.js
- Encryption backend is bundled and installed automatically

## Install

```bash
npm i -g redpill-vault
```

## Quick start

```bash
# 1) Initialize vault + hook in your project
rv init

# 2) Import secrets from an existing .env file
rv import .env

# 3) Approve this project for injection
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
rv import .env      # import secrets from a .env file into vault + .rv.json
rv import .env -g   # import as global keys
rv set KEY          # set a single secret (reads value from stdin)
rv set KEY -g       # set as global key
rv rm KEY           # remove a secret from vault
rv rm KEY -g        # remove a global key
rv list             # list keys with source ([project]/[global]/[missing])
rv approve          # allow this project to inject its secrets
rv revoke           # remove approval
rv check            # verify keys exist in vault
rv doctor           # full health check
```

## Notes

- Secrets are injected per-project based on `.rv.json` and approval state.
- The agent never sees secret values; `rv-exec` resolves them at execution time from the encrypted vault.
