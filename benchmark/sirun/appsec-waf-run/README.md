This benchmark measures `WAFContextWrapper.run()` in
`packages/dd-trace/src/appsec/waf/waf_context_wrapper.js`. AppSec-enabled
apps run this on every request (often twice — once for persistent inputs
at the start, once for ephemeral path params later), so the wrapper's
per-call allocations (skip-set clone, metrics literal, payload filtering
loops) compound across the request rate.

The native WAF binding is stubbed so the bench isolates the wrapper's
own work; the real `ddwafContext.run()` shells out to
`@datadog/native-appsec` and dwarfs the wrapper cost. `Reporter`'s tag /
metric methods are also stubbed for the same reason. Pre-flight
assertion confirms the wrapper actually reaches the stubbed native path
on a representative input shape; without it, a refactor that
short-circuits early would silently produce a green result at
microsecond timings.

Variants:

- `persistent-only` — initial-dispatch shape: 8 known headers + query +
  body + URL + method, no ephemeral inputs.
- `persistent-and-ephemeral` (`baseline: persistent-only`) — full shape:
  the same persistent payload plus per-route `path_params` and the
  client IP. Catches a regression in the ephemeral input filter loop.
