# AGENTS.md

## Purpose

This repository contains the `vibepress` workspace: a WordPress-to-React pipeline plus supporting apps.

Use this file as the first-stop orientation guide before changing code. It is written for human contributors and coding agents.

## Workspace Map

- `ai-pipeline/`
  NestJS backend and the core orchestration pipeline.
  This is the main source of truth for WordPress parsing, planning, generation, validation, preview building, and edit-request flows.

- `xpress-react-spa/`
  React + Vite frontend used for the editor / SPA side of the system.

- `automation/`
  Supporting automation service used alongside the pipeline.

- `db/`
  Database-related assets and local environment support.

- `ai-pipeline/temp/`
  Runtime artifacts only.
  Includes cloned repos, generated previews, logs, and job outputs.
  Do not treat this directory as authoritative source code.

- `ai-pipeline/dist/`
  Compiled Nest output.
  Never edit by hand unless you are debugging a running local job and explicitly accept that it is temporary.

## Source of Truth

Prefer editing these locations:

- Pipeline logic: `ai-pipeline/src/**`
- Express preview template: `ai-pipeline/templates/express-server/**`
- React SPA source: `xpress-react-spa/src/**`

Avoid committing manual edits to:

- `ai-pipeline/temp/**`
- `ai-pipeline/dist/**`
- generated preview apps under `ai-pipeline/temp/generated/**`

Temporary edits in generated preview folders are acceptable only for local debugging, and should usually be mirrored back into real source files afterward.

## Core Pipeline Architecture

For `ai-pipeline`, the high-level flow is:

1. Parse and normalize WordPress source
   Files: `src/modules/agents/php-parser`, `block-parser`, `normalizer`, `source-resolver`

2. Extract DB-backed content and runtime theme data
   Files: `src/modules/sql`, `src/modules/agents/db-content`

3. Build architecture plan
   Files: `src/modules/agents/planner`, `plan-reviewer`

4. Generate React code
   Files: `src/modules/agents/react-generator`

5. Validate and repair code
   Files: `src/modules/agents/validator`, plus validator-related flows inside `orchestrator.service.ts`

6. Build preview app
   Files: `src/modules/agents/preview-builder`, template sources in `templates/express-server`

7. Orchestrate the end-to-end job lifecycle
   Files: `src/modules/orchestrator`

If you are unsure where a behavior belongs, start at:

- `ai-pipeline/src/modules/orchestrator/orchestrator.service.ts`

That file is the best entry point for understanding stage order, retries, artifact writing, validation gates, and preview generation.

## Important Modules

- Planner
  `ai-pipeline/src/modules/agents/planner/`
  Responsible for route contracts, concrete page expansion, visual planning, and section planning.

- React Generator
  `ai-pipeline/src/modules/agents/react-generator/`
  Responsible for codegen, code review, fix-agent behavior, prompts, and visual-plan schema.

- Validator
  `ai-pipeline/src/modules/agents/validator/`
  Enforces route/data contracts, structural constraints, and preview/runtime checks.

- Preview Builder
  `ai-pipeline/src/modules/agents/preview-builder/`
  Assembles generated code into runnable preview apps and wires routes/build/run checks.

- WordPress section heuristics
  `ai-pipeline/src/common/utils/wp-node-to-sections-mapper.ts`
  Central heuristic mapper from parsed WP nodes into draft visual sections.

## Commands

Root workspace:

- Start pipeline prod build:
  `npm run start:ai-pipeline`

- Start SPA:
  `npm run start:xpress-app`

- Start all services:
  `npm run start:all`

Pipeline:

- Build:
  `cd ai-pipeline && npm run build`

- Dev watch:
  `cd ai-pipeline && npm run start:dev`

- Test:
  `cd ai-pipeline && npm run test`

SPA:

- Dev:
  `cd xpress-react-spa && npm run dev`

- Build:
  `cd xpress-react-spa && npm run build`

## Working Rules

- Make changes in source, not in `temp/` or `dist/`, unless you are doing short-lived local debugging.

- If you patch a generated preview app to verify a fix, also patch the real source file that produces it.

- If you change anything under:
  - `ai-pipeline/src/**`
  - `ai-pipeline/templates/**`
  then rebuild `ai-pipeline` before concluding the change is done.

- If the bug reproduces only in a specific job, inspect:
  - `ai-pipeline/temp/logs/<job-id>/plan.final.json`
  - `ai-pipeline/temp/logs/<job-id>/plan.visual-attempt-1.json`
  - `ai-pipeline/temp/generated/<job-id>/`

- Treat `plan.final.json` as an artifact of a run, not as editable source-of-truth.

## Route and Contract Expectations

- The planner owns the route map.
- The generator and preview builder must follow the approved plan contract.
- The validator is the final authority on whether generated code still matches that contract.

When debugging route issues, check these three layers in order:

1. Planner output
   `plan.final.json`

2. Generated React routes
   preview `frontend/src/App.tsx`

3. API/menu URL normalization
   `ai-pipeline/src/modules/sql/wp-query.service.ts`
   and `ai-pipeline/templates/express-server/index.ts`

## Logging and Artifacts

- Planner logs and plan artifacts live under:
  `ai-pipeline/temp/logs/<job-id>/`

- Generated preview apps live under:
  `ai-pipeline/temp/generated/<job-id>/`

- Repo snapshots for a job live under:
  `ai-pipeline/temp/repos/<job-id>/`

When investigating a generation issue, correlate:

- selected planning source
- draft sections
- reviewed visual plan
- generated TSX
- validator output

Do not assume a single log line explains the whole failure.

## Common Pitfalls

- Editing `dist/` without mirroring source changes
  This only fixes the current local process and will be lost on rebuild.

- Editing `temp/generated/...`
  This helps debug a job but does not fix future jobs unless the source/template is also updated.

- Assuming theme template files contain all actual content
  In many jobs, the real structure comes from DB-backed `wp_template`, `wp_template_part`, `wp_navigation`, posts, or pages.

- Blaming React first for navigation issues
  Many menu and route bugs originate in planner contracts or API URL normalization.

## Preferred Debugging Order

When behavior is wrong in preview:

1. Confirm the plan contract
2. Confirm the generated app follows the plan
3. Confirm API payload shape and canonical URLs
4. Confirm validator expectations
5. Only then change prompts or heuristics

## If You Add New Behavior

Document it close to the real source:

- route policy changes near planner or plan-reviewer
- section heuristics near `wp-node-to-sections-mapper.ts`
- codegen contracts near validator or generator prompts
- preview/runtime wiring near preview-builder or express template

Keep policy logic centralized. Do not duplicate the same routing or content-contract rule in multiple places unless a downstream layer is explicitly enforcing it.
