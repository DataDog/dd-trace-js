Replays request payloads captured at the native WAF boundary. This isolates WAF
context creation and execution from HTTP client scheduling and tracer request
instrumentation. The matching `appsec` benchmark uses the same samples with a
replaying WAF implementation, so the two benchmarks cover both layers without
measuring them in the same timing window.
