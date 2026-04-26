# `.claude`

Shared project files:

- `commands/`: project slash commands for recurring Vibepress workflows
- `rules/`: markdown files imported by the root `CLAUDE.md`
- `settings.json`: repo-shared Claude Code permissions that are safe for the team

Local-only files:

- `settings.local.json`: personal permissions and machine-specific allowances
- `local/`: optional personal notes or helpers that should not be committed

The project entrypoint for Claude memory is the repo-root `CLAUDE.md`, not `.claude/CLAUDE.md`.
