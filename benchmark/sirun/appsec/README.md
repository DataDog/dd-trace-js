This benchmarks the HTTP instrumentation and result-processing cost Datadog
AppSec adds to a server. A keep-alive client drives the tracer-instrumented
server, while a replaying native-WAF implementation verifies the request data
against `waf-samples.json` and returns its captured result. Native WAF execution
is measured separately by `appsec-waf` using the same samples.

`record-waf-sample.js` can be preloaded in place of the replaying implementation
to regenerate a sample with the real native WAF after the request shape or
ruleset changes.
