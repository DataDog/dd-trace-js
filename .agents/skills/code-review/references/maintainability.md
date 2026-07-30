# Maintainability

Check whether the next maintainer can understand and safely change the code:

- This lens owns ordinary behavioral correctness that does not belong to another lens.
- Trace requirements, changed control and data flow, return values, and state transitions through the real caller.
- Check boundary values, empty and invalid inputs, partial failures, retries, cleanup, and error propagation.
- Names, control flow, state ownership, and error behavior should make the contract apparent.
- Shared invariants should live in one place rather than depend on synchronized edits.
- Tests should exercise the real production path and pin failures, siblings, boundaries, and observable behavior.
- Treat comments as part of maintainability. Keep them very brief, avoid adding more than the surrounding code has, and never narrate the diff. Zero comments is perfectly okay.

File findings for wrong behavior, concrete ambiguity, hidden coupling, drift risk, or tests that would pass while production is broken. Do not turn personal style preferences into findings.
