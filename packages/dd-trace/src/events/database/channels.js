'use strict'

const { createLifecycleChannels } = require('../lifecycle')

const query = createLifecycleChannels('tracing:datadog:db:query', [
  'start',
  'finish',
  'error',
])

module.exports = {
  queryStart: query.start,
  queryFinish: query.finish,
  queryError: query.error,
}
