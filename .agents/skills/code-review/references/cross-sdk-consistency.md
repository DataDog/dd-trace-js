# Cross-SDK consistency

Check user-visible behavior against Datadog specifications and sibling SDKs:

- Compare configuration names, environment variables, defaults, units, and enablement rules.
- Compare span names, operation names, service names, tags, error semantics, and telemetry.
- Check propagation, sampling, trace identity, and feature lifecycle behavior.
- Account for intentional language or major-version differences and backward compatibility.
- Prefer shared specifications, then current sibling-SDK code and tests.

Name the specification or SDK source used as evidence. Do not rely on memory. If relevant sources are unavailable,
report that limitation instead of asserting inconsistency. Internal implementation details do not need to match
when externally observable behavior does.
