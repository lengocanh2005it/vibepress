---
description: Audit shared Header, Footer, and Navigation contracts across generator, validator, preview builder, and generated preview files.
argument-hint: [job-id]
allowed-tools: Bash(rg *), Read, Grep
---

Audit shared chrome behavior for the migration pipeline.

Job hint: `$ARGUMENTS`

Check these concerns:

1. Shared chrome data contracts for `/api/site-info`, `/api/menus`, and `/api/footer-links`.
2. Prompt or generator assumptions that cause hardcoded nav or footer output.
3. Validator rules that should reject shared chrome being rendered as plain content.
4. Generated preview components for header/footer drift in the target job, if provided.

Report findings in severity order with file references and explain whether the fix belongs in parser, planner, generator, validator, or preview builder.
