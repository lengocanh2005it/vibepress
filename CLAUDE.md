# Vibepress Claude Memory

Read @AGENTS.md first for repo-wide rules, source-of-truth boundaries, and module ownership.

Then load the project-specific Claude guidance:

- @.claude/rules/repo-overview.md
- @.claude/rules/migration-debugging.md

Project slash commands live in @.claude/commands/README.md.

Keep this file short and stable. Put durable project instructions in imported files and store personal machine-specific preferences in ignored local files.

## Memory Sentinel

If the user asks exactly `memory-check`, respond with exactly:

`VIBEPRESS_CLAUDE_MEMORY_OK`
