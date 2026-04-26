---
description: Build or validate the NestJS ai-pipeline service after code changes.
argument-hint: [optional-focus]
allowed-tools: Bash(npm run build), Bash(npm run test), Bash(npm run lint *), Read, Grep
---

Validate the `ai-pipeline` workspace.

Focus: `$ARGUMENTS`

Workflow:

1. Inspect the relevant files for the requested focus if one was provided.
2. Run the smallest useful validation command inside `ai-pipeline/`.
3. Prefer `npm run build` first unless the focus clearly points to linting or tests.
4. Report failures with file paths, likely cause, and the next fix to make.
5. If everything passes, summarize what was validated and any remaining gaps.
