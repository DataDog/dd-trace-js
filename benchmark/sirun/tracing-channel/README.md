# tracing-channel

Critical-path bench. Every instrumented operation, regardless of integration, is
dispatched into its plugin through the diagnostic channels the `Plugin` base binds
and subscribes to: `apm:<id>:<operation>:start` runs the store binding (`bindStart`)
and `:finish` notifies the subscription (`finish`). This isolates that generic
dispatch cost with a plugin whose handlers do nothing integration-specific, so it
is measured once here instead of being folded into — and diluting — every
per-integration plugin benchmark, which call their handler directly.
