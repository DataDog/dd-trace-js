# sampling

Measures `PrioritySampler.sample()`, the per-trace sampling decision run once at
each trace root: manual-tag check, sampling-rule glob match, deterministic Knuth
hash, token-bucket rate limit, agent-rate fallback, and decision-maker tagging.
Variants exercise the agent-rate path, a matching rule, a non-matching rule scan,
and the rate-limited reject branch.
