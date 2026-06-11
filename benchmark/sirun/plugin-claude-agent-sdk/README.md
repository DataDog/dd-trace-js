# plugin-claude-agent-sdk benchmark

Measures the overhead of `@anthropic-ai/claude-agent-sdk` instrumentation.

Each session simulates 3 turns with 2 tool calls each (22 hook invocations per session).
Runs 500 sessions in control (no tracer) and with-tracer variants.
