# Maintainability

Check whether the next maintainer can understand and safely change the code:

- This lens owns ordinary behavioral correctness that does not belong to another lens.
- Trace requirements, changed control and data flow, return values, and state transitions through the real caller.
- Check boundary values, empty and invalid inputs, partial failures, retries, cleanup, and error propagation.
- Names, control flow, state ownership, and error behavior should make the contract apparent.
- Shared invariants should live in one place rather than depend on synchronized edits.
- Tests should exercise the real production path and pin failures, siblings, boundaries, and observable behavior.
- Avoid test-only exports, fake prototype instances, or production surfaces added only for tests.
- Comments should explain constraints the code cannot carry, not narrate the diff.
- Check cancellation and lifecycle transitions.

File findings for wrong behavior, concrete ambiguity, hidden coupling, drift risk, or tests that would pass while
production is broken. Do not turn personal style preferences into findings.
