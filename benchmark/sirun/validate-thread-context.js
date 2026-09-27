'use strict'

const assert = require('node:assert/strict')

/**
 * Fails a context-enabled benchmark before timing if the thread-context writer did
 * not install a record. Unsupported runtimes deliberately remain no-ops: the
 * benchmark matrix still runs them to guard that fallback, but only Linux
 * AsyncContextFrame results measure the writer.
 *
 * @param {import('../../index')} tracer
 */
module.exports = function validateThreadContext (tracer) {
  const { isACFActive } = require('../../packages/datadog-core/src/storage')
  if (process.platform !== 'linux' || !isACFActive) return

  const { getContext } = require('@datadog/pprof').otelThreadCtx
  const span = tracer.startSpan('sirun.thread-context.preflight')
  let activeContext

  tracer.scope().activate(span, () => {
    activeContext = getContext()
  })
  span.finish()

  assert.ok(activeContext, 'thread-context writer did not install a thread context during benchmark preflight')
}
