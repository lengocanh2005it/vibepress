---
description: Build a generated preview frontend for a specific job id or the latest active generated job.
argument-hint: [job-id]
allowed-tools: Bash(rg *), Bash(npm run build), Read, Grep
---

Validate a generated preview frontend under `ai-pipeline/temp/generated`.

Job hint: `$ARGUMENTS`

Workflow:

1. Resolve the target job id from `$ARGUMENTS`; if it is empty, inspect `ai-pipeline/temp/generated/` and choose the most relevant recent job directory.
2. Verify the expected frontend path exists: `ai-pipeline/temp/generated/<job-id>/frontend`.
3. Inspect the generated app entry points or the component mentioned by the user before building.
4. Run `npm run build` inside that frontend directory.
5. Report build failures with exact file references and likely generator/template layers to fix.
