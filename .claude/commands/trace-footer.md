---
description: Trace footer data flow from WordPress extraction to preview API and generated Footer React output.
argument-hint: [job-id]
allowed-tools: Bash(rg *), Read, Grep
---

Trace why footer links or footer structure are missing or degraded.

Job hint: `$ARGUMENTS`

Inspect this flow in order:

1. WordPress extraction and SQL/query sources under `ai-pipeline/src/modules/sql/`.
2. Orchestration and preview assembly logic under `ai-pipeline/src/modules/orchestrator/` and `ai-pipeline/src/modules/agents/preview-builder/`.
3. Express preview API templates under `ai-pipeline/templates/express-server/` and, if relevant, the generated server for the target job.
4. Generated footer component under `ai-pipeline/temp/generated/<job-id>/frontend/src/components/Footer.tsx` when a job id is available.

Output:

- Identify where footer links become plain text, disappear, or stop being mapped as anchors.
- Call out the earliest safe layer to fix.
- Mention any validator or generator contract that should be tightened.
