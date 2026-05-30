'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const LogPropagator = require('../../../packages/dd-trace/src/opentracing/propagation/log')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')

const COUNT = Number(process.env.COUNT)

// Typical production config: 128-bit trace ids on, service/version/env set.
const config = {
  service: 'web-api',
  version: '1.2.3',
  env: 'production',
  traceId128BitGenerationEnabled: true,
  traceId128BitLoggingEnabled: true,
}
const propagator = new LogPropagator(config)

// A small pool of span contexts: per-context id strings memoize after the first
// inject, mirroring the common case of many log lines sharing a request span,
// while each iteration still pays the holder build, field selection and splice.
const POOL = 16
const contexts = Array.from({ length: POOL }, (_, i) => {
  const hex = (i + 1).toString(16).padStart(16, '0')
  const ctx = new DatadogSpanContext({
    traceId: id('1234567890ab' + hex.slice(0, 4), 16),
    spanId: id(hex, 16),
  })
  ctx._trace.tags['_dd.p.tid'] = '640cfd8d0000000' + (i % 10)
  return ctx
})

// A representative pino JSON line: the splice in handleJsonLine runs on this
// per record for high-volume structured logging.
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

// Mirrors PinoPlugin.handleJsonLine: splice ,"dd":<json> before the last brace.
function spliceDd (line, dd) {
  const lastClose = line.lastIndexOf('}')
  if (lastClose < 1) return line
  const ddJson = JSON.stringify(dd)
  const sep = line.charCodeAt(lastClose - 1) === 0x7B ? '' : ','
  return line.slice(0, lastClose) + sep + '"dd":' + ddJson + line.slice(lastClose)
}

// Verify the inject path produces a dd log-correlation object and that it
// splices into the line before the timed loop, so a broken propagator fails
// loudly instead of silently measuring a no-op.
{
  const holder = {}
  propagator.inject(contexts[0], holder)
  assert.ok(holder.dd?.trace_id, 'log propagator did not inject a trace_id')
  assert.ok(spliceDd(baseLine, holder.dd).includes('"dd":'), 'dd field not spliced into the log line')
}

guard.loopStart()
let sink = 0
for (let i = 0; i < COUNT; i++) {
  const holder = {}
  propagator.inject(contexts[i & (POOL - 1)], holder)
  sink += spliceDd(baseLine, holder.dd).length
}

assert.ok(sink > 0, 'pino bench produced no output')
guard.done()
