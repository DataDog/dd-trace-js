'use strict'

const assert = require('node:assert/strict')

const { isTrue } = require('../../packages/dd-trace/src/util')

/**
 * Fails a context-enabled benchmark before timing if the thread-context writer did
 * not install a record. Unsupported runtimes deliberately remain no-ops: the
 * benchmark matrix still runs them to guard that fallback, but only Linux
 * AsyncContextFrame results measure the writer.
 *
 * @param {import('../../index')} tracer
 */
module.exports = function validateThreadContext (tracer) {
  if (!isTrue(process.env.DD_TRACE_OTEL_CTX_ENABLED)) return

  const { isACFActive } = require('../../packages/datadog-core/src/storage')
  if (process.platform !== 'linux' || !isACFActive) return

  const { getThreadLocalMetadata } = require('../../packages/dd-trace/src/otel-thread-ctx')
  assert.ok(getThreadLocalMetadata(), 'thread-context writer did not start during benchmark preflight')

  const { getContext } = require('@datadog/pprof').otelThreadCtx
  const span = tracer.startSpan('sirun.thread-context.preflight')
  let activeContext

  tracer.scope().activate(span, () => {
    activeContext = getContext()
  })
  span.finish()

  assert.ok(activeContext, 'thread-context writer did not install a thread context during benchmark preflight')
}
