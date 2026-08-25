---
name: architecture-review
description: |
  Use when a dd-trace-js change introduces or substantially changes a class hierarchy, module boundary, shared helper
  layer, public API, or duplicated behavior across multiple types. Triggers: architecture decision, design review,
  refactor shared behavior, new abstraction, composition versus inheritance, expose internals, module coupling,
  public surface, hot-path architecture, score the design.
---

# Architecture Review

Use this skill before implementing a non-trivial structural change. Do not use it for a local bug fix or a small
refactor whose boundaries and contracts remain unchanged.

The score is a decision aid, not a substitute for reasoning. Explain the evidence behind each score and reject an
abstraction that adds complexity without improving the baseline.

## Workflow

1. Describe the current design as the baseline, including its duplication, coupling, contracts, tests, and hot path.
2. Describe the smallest viable proposal and at most one meaningful alternative.
3. Identify affected public APIs, package boundaries, consumers, and per-call production paths.
4. Score the baseline and proposal from 1–10 on each dimension below using `baseline → proposal`.
5. Require the proposal to score at least 8/10 on five dimensions. Treat regressions in public-surface discipline or
    hot-path fitness as blockers even if the aggregate score passes.
6. Ask the user before implementation when two viable designs have meaningful trade-offs.
7. Record the selected design's contracts and cover boundaries with observable tests.

## Six Dimensions

### 1. Drift prevention

Behavior shared by multiple types should live in one place. Adding a precondition or branch should touch one site,
not require synchronized edits across implementations.

### 2. Module coupling

Cross-module access must use an intentional boundary, never another class's internals. Adding methods to npm-exported
classes such as `Span`, `Tracer`, or OpenTelemetry bridge spans is a lasting compatibility commitment. Prefer a
callback, diagnostic channel, composition, or a redesigned module boundary over exposing internal state.

### 3. Explicit contracts

Express invariants through constructor signatures, specific JSDoc types, narrow interfaces, abstract methods when
appropriate, and `#private` state. Do not rely on undocumented conventions between modules.

### 4. Testability at boundaries

Test boundaries with multiple consumers or protocol/specification contracts directly. Exercise real entry points and
observable output; do not export internals or construct impossible object states solely for tests.

### 5. Extensibility

Evaluate the likely next consumer, type, or method. A third implementation should require a localized addition rather
than edits across every existing implementation. Do not add speculative generality without a credible next case.

### 6. Hot-path fitness

Measure overhead at architectural boundaries on the actual call path. Avoid extra allocations, closures, dispatch,
parsing, and listeners per call. A performance-motivated increase in complexity requires focused, reproducible
benchmark evidence.

## Decision Rules

- Prefer composition. Use inheritance only when at most two sibling types share a complete interface contract and the
  hierarchy makes that contract clearer.
- Score the baseline honestly; a `7 → 7` rewrite is not architectural progress.
- Treat test-only exports and accessors as public-surface expansion when evaluating coupling.
- Prefer the simpler implementation when scores and measured performance are effectively equal.
- Avoid new public APIs unless the use case requires a durable compatibility contract.
- If upstream owns the broken abstraction, prefer an upstream fix over a permanent local workaround.

## Review Output

Summarize the review in a compact table:

| Dimension | Baseline | Proposal | Evidence |
| --- | ---: | ---: | --- |
| Drift prevention | | | |
| Module coupling | | | |
| Explicit contracts | | | |
| Testability at boundaries | | | |
| Extensibility | | | |
| Hot-path fitness | | | |

Then state the decision, rejected alternatives, remaining risks, and the validation needed before merging.
