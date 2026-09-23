# Setup registration

`diffninja setup` detects the agent CLIs present on PATH (Claude Code, Codex, OMP, pi) and registers `diffninja-mcp` as a stdio MCP server in each one's config. It prefers a global npm install and falls back to an `npx` entry. Any other invocation of `diffninja` only explains how to review through an agent.

## Sub-features

- `setup-detect` selects CLIs automatically, or takes them from `--cli claude,codex,omp,pi`.
- `setup-entry` resolves a global install, or an `npx -y -p diffninja diffninja-mcp` entry with `--no-install` or when npm is unavailable.
- `setup-edit` edits `~/.claude.json`, `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and the OMP and pi configs atomically, and refuses conflicting edits.
- `setup-dry-run` previews the edits with `would update <path>` lines and writes no config.
- `setup-uninstall` removes the entries with `--uninstall`.
- `cli-no-review` makes any command other than `setup` print guidance without echoing its arguments.

## How to get to it (user POV)

- After `npm install -g diffninja`, the user runs `diffninja setup`, then asks their agent to review something.

## Driving it with drive.mjs

Setup is a plain CLI, so drive it directly with node. It is not an MCP call.

Preconditions:

- `npm run build` has run.
- A disposable HOME exists: `H=$(mktemp -d)`. Never run a real (non-dry) setup against the user's HOME.

- **Dry run.** Run `HOME="$H" CODEX_HOME="$H/.codex" node dist/review/cli.js setup --dry-run --no-install --cli claude,codex`. It exits 0 and prints `[claude] would update ~/.claude.json` and `[codex] would update ~/.codex/config.toml`.
- **Check the side effects.** Run `find "$H" -type f`. No config file exists. The only file is an npm debug log under `$H/.npm/_logs`, because the dry run still runs `npm root -g`.
- **Real edit in isolation.** Run `mkdir -p "$H/.codex" && HOME="$H" CODEX_HOME="$H/.codex" node dist/review/cli.js setup --no-install --cli claude,codex`. Then `$H/.claude.json` and `$H/.codex/config.toml` each contain a `diffninja` server entry.
- **No terminal review.** Run `node dist/review/cli.js review x`. It prints guidance to review through an agent, and does not echo `x`.
- **Proof and cleanup.** Copy the `find` output and the config files into the evidence directory, then `rm -rf "$H"`.

## Gotchas

- Without `--no-install`, a non-dry setup runs `npm install -g diffninja` from the public registry. Keep `--no-install` for verification.
- Codex reads `CODEX_HOME` before HOME. Set both, or a run can edit the user's real Codex config.
- `--dry-run` is not network-free: npm may contact the registry config while resolving the global root.
