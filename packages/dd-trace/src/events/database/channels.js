'use strict'

const { createLifecycleChannels } = require('../lifecycle')

const query = createLifecycleChannels('tracing:datadog:db:query', [
  'start',
  'finish',
  'error',
])

module.exports = {
  queryError: query.error,
  queryFinish: query.finish,
  queryStart: query.start,
}
