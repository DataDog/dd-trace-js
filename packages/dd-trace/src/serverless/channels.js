'use strict'

const { createLifecycleChannels } = require('../events/lifecycle')

const invocation = createLifecycleChannels('tracing:datadog:serverless:invocation', [
  'start',
  'finish',
  'error',
  'timeout',
])
const flush = createLifecycleChannels('tracing:datadog:serverless:flush', [
  'start',
  'handed_off',
  'timed_out',
  'failed',
  'disabled',
  'empty',
])

module.exports = {
  invocationStart: invocation.start,
  invocationFinish: invocation.finish,
  invocationError: invocation.error,
  invocationTimeout: invocation.timeout,
  flushStart: flush.start,
  flushHandedOff: flush.handed_off,
  flushTimedOut: flush.timed_out,
  flushFailed: flush.failed,
  flushDisabled: flush.disabled,
  flushEmpty: flush.empty,
}
