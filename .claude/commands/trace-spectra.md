---
description: Inspect Spectra or UAGB block usage and determine parser, mapper, planner, and generator support gaps.
argument-hint: [optional-block-name]
allowed-tools: Bash(rg *), Read, Grep
---

Trace support for Spectra / UAGB blocks and style classes.

Focus block: `$ARGUMENTS`

Inspect this flow:

1. WordPress block normalization in `ai-pipeline/src/common/utils/wp-block-to-json.ts`.
2. Section mapping in `ai-pipeline/src/common/utils/wp-node-to-sections-mapper.ts`.
3. Planning schemas or section contracts used by the React generator.
4. React generation, validator, and preview CSS bridging for interactive or styled blocks.

Prioritize:

- modal / popup behavior
- carousel / slider behavior
- tabs / accordion behavior
- style classes such as `is-style-*` that should map to deterministic React semantics

Conclude with the earliest durable implementation path instead of a prompt-only workaround.
