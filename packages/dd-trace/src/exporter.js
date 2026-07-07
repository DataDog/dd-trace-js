'use strict'

const exporters = require('../../../ext/exporters')

// On the native-spans branch, `getExporter` is only used for the CI Visibility
// pipeline — regular APM tracing uses the native exporter (see
// `opentracing/tracer.js`). `ci/init.js` sets `experimental.exporter` to one of
// the CI-vis exporter names below, so this maps those names to the matching
// CI-vis exporter. The APM exporters (agent/agentless/log/electron) are not part
// of this pipeline and are intentionally not referenced here.
module.exports = function getExporter (name) {
  switch (name) {
    case exporters.DATADOG:
      return require('./ci-visibility/exporters/agentless')
    case exporters.AGENT_PROXY:
      return require('./ci-visibility/exporters/agent-proxy')
    case exporters.JEST_WORKER:
    case exporters.CUCUMBER_WORKER:
    case exporters.MOCHA_WORKER:
    case exporters.PLAYWRIGHT_WORKER:
    case exporters.VITEST_WORKER:
      return require('./ci-visibility/exporters/test-worker')
    default:
      // ci/init.js always sets one of the names above; fall back to the
      // agent-proxy exporter (the non-agentless CI-vis default) for safety.
      return require('./ci-visibility/exporters/agent-proxy')
  }
}
