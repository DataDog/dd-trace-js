---
max_test_iterations: 10
---

Investigate whether the reported integration behavior is a real bug, an intentional prior decision, or an existing
but undocumented configuration capability. Read the task report before choosing code changes.

1. Inspect git history and prior decisions before treating the report as a regression.
2. Check whether the requested opt-out already exists in composite-plugin configuration and only lacks supported
   types/docs exposure.
3. Reproduce the reported behavior before changing production code.
4. Trace the concrete mechanism and apply the minimum code, types, or documentation fix it proves.
5. Preserve unrelated span names, tags, resource names, APM tracing, and trace-context propagation.
6. Retain a regression test and verify the real emitted observability behavior, not merely test assertions.

Do not broadly suppress tool spans, weaken tests, refactor unrelated LLMObs plugins, or remove MCP propagation.
