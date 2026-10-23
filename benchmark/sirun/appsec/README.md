This benchmarks the HTTP instrumentation and result-processing cost Datadog
AppSec adds to a server. A keep-alive client drives the tracer-instrumented
server, while a replaying native-WAF implementation verifies the request data
against `waf-samples.json` and returns its captured result. Native WAF execution
is measured separately by `appsec-waf` using the same samples.

The request workload includes a paired variant with the thread-context
writer explicitly enabled. The AppSec-only variants explicitly disable it so a
future AppSec auto-enablement change cannot silently move the baseline. Writer
overhead is meaningful on Linux runtimes using AsyncContextFrame; unsupported
runtimes exercise the writer's no-op fallback.
