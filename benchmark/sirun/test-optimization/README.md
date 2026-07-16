# test-optimization

Measures the Test Optimization msgpack event encoder, the egress path for every
test, suite, module and session event: `truncateSpanTestOpt`, `normalizeSpan`,
the per-event-type map encode, and `makePayload`. It is the test-event sibling of
the `encoding` (trace) bench. Variants cover a small suite, a large suite, and a
wide-tag event shape.
