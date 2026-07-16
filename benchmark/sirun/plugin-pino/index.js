'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const { storage } = require('../../../packages/datadog-core')
const LogPropagator = require('../../../packages/dd-trace/src/opentracing/propagation/log')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')
const PinoPlugin = require('../../../packages/datadog-plugin-pino/src/index')

const legacyStorage = storage('legacy')

const OPERATIONS = Number(process.env.OPERATIONS)

// Typical production config: 128-bit trace ids on, service/version/env set.
const config = {
  service: 'web-api',
  version: '1.2.3',
  env: 'production',
  traceId128BitGenerationEnabled: true,
  traceId128BitLoggingEnabled: true,
}
const propagator = new LogPropagator(config)

// One request's span context: many log lines share it, so the holder build hits
// the memoized-id path that dominates high-volume structured logging.
const spanContext = new DatadogSpanContext({
  traceId: id('1234567890abcdef', 16),
  spanId: id('abcdef1234567890', 16),
})
spanContext._trace.tags['_dd.p.tid'] = '640cfd8d00000001'

// The pino plugin's only tracer touchpoint is inject(span, LOG, holder), where the
// span is whatever buildLogHolder read from legacy storage. Mirror the real tracer:
// pull the context off that span and route it through the real LogPropagator, so the
// storage lookup is part of the measured path and a broken lookup is reflected here.
const activeSpan = { context: () => spanContext }
const tracer = {
  inject (span, _format, holder) {
    propagator.inject(span?.context(), holder)
  },
}

// Drive the real PinoPlugin.handleJsonLine: buildLogHolder + the JSON splice are
// production code, so a change to either is reflected here. Skip the diagnostic
// channel subscriptions since the handler is invoked directly.
class BenchedPinoPlugin extends PinoPlugin {
  addSub () {}
}
const plugin = new BenchedPinoPlugin(tracer, { logInjection: true })
plugin.configure({ enabled: true, logInjection: true, service: 'web-api' })

// A representative pino JSON line: handleJsonLine splices into this per record.
const baseLine = JSON.stringify({
  level: 30,
  time: 1716950000000,
  pid: 12345,
  hostname: 'web-api-7d4f',
  msg: 'request completed',
  req: { method: 'GET', url: '/api/v2/users/12345' },
  res: { statusCode: 200 },
  responseTime: 42,
})

// One request's span lives in legacy storage for the duration of its log lines, so
// run the handler inside that context: buildLogHolder's getStore lookup resolves to
// the active span and the trace id is injected, exactly as in the request hot path.
let sink = 0
legacyStorage.run({ span: activeSpan }, () => {
  // Verify the real handler injects the trace id + splices before the timed loop, so a
  // broken plugin or a propagator that drops the trace id fails loudly instead of
  // silently measuring a no-op (service/env alone would still produce a dd field).
  const probe = { line: baseLine }
  plugin.handleJsonLine(probe)
  assert.ok(probe.line.includes('"trace_id":'), 'pino plugin did not inject the trace id into the line')

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    const payload = { line: baseLine }
    plugin.handleJsonLine(payload)
    sink += payload.line.length
  }
})

assert.ok(sink > 0, 'pino bench produced no output')
guard.done()
