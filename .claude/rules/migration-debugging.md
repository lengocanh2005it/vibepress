# Migration And Debugging Rules

## Fix The Earliest Reliable Layer

When output quality is wrong, fix the earliest deterministic layer that can solve it permanently:

- wrong source structure -> parser / normalizer
- wrong section semantics -> mapper / planner / visual plan schema
- wrong runtime behavior -> generator / preview builder / validator
- wrong compare or metrics payload -> orchestrator / automation contract

Do not default to "strengthen the prompt" when code or schema changes can make the behavior reliable.

## Shared Chrome Contracts

Header, footer, and navigation partials are not normal page sections.

- header usually depends on `/api/site-info` and `/api/menus`
- footer may also need `/api/footer-links`
- page components must not duplicate shared chrome

If nav or footer links are hardcoded, inspect validator, generator contracts, and preview API wiring before changing component markup.

## Preserve WordPress Fidelity

This system is migration-oriented, not greenfield UI generation.

- preserve route structure
- preserve content and data contracts
- preserve shared layout behavior
- preserve meaningful WordPress classes or bridge them in preview CSS when needed

## Interactive Plugin Blocks

For Spectra, UAGB, Elementor-like, or similar interactive blocks, prefer deterministic adapters:

1. detect in parser normalization
2. map into internal section/schema
3. render deterministic React
4. enforce behavior in validator/runtime checks

## Preferred Debugging Order

When preview behavior is wrong:

1. confirm the plan contract
2. confirm generated app output follows the plan
3. confirm API payload shape and canonical URLs
4. confirm validator expectations
5. only then change prompts or heuristics
