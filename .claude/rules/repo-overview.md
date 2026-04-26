# Repo Overview

## Workspace Map

- `ai-pipeline/`: main source of truth for WordPress parsing, planning, generation, validation, preview building, and orchestration
- `xpress-react-spa/`: React + Vite editor / SPA frontend
- `automation/`: supporting automation service for compare and utility workflows
- `db/`: database-related assets and local environment support

For migration fidelity and generated preview behavior, start in `ai-pipeline/` unless evidence points elsewhere.

## Source Of Truth

- Prefer editing `ai-pipeline/src/**`, `ai-pipeline/templates/**`, and `xpress-react-spa/src/**`
- Do not treat `ai-pipeline/temp/**` or `ai-pipeline/dist/**` as permanent source code
- If a fix is verified in a generated preview app, mirror it back into the real source/template that produced it

## AI Pipeline Entry Points

- `src/modules/orchestrator/orchestrator.service.ts`: stage order, retries, artifact writing, validation gates, preview generation
- `src/modules/agents/planner/`: route/data/section planning
- `src/modules/agents/react-generator/`: deterministic generation plus AI review/repair loop
- `src/modules/agents/validator/`: contract and behavior validation
- `src/modules/agents/preview-builder/`: preview app assembly and runtime wiring
- `src/common/utils/wp-node-to-sections-mapper.ts`: central deterministic WP node -> section draft mapping

## Build And Validation

- Rebuild `ai-pipeline` after changes under `ai-pipeline/src/**` or `ai-pipeline/templates/**`
- Use the smallest useful validation command first
- Prefer source-layer fixes over prompt-only fixes when a deterministic correction is possible
