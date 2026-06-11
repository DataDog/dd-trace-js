# test-ci-encode

Measures the agentless CI-visibility msgpack encoder, the egress path for every
test, suite, module and session event: `truncateSpanTestOpt`, `normalizeSpan`,
the per-event-type map encode, and `makePayload`. It is the CI sibling of the
`encoding` (trace) bench. Variants cover a small suite, a large suite, and a
wide-tag event shape.
