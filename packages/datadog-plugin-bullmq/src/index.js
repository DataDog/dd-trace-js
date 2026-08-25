'use strict'

const { createMessagingIntegration } = require('../../dd-trace/src/events/messaging')
const consumerSource = require('./consumer')
const { getFilter } = require('./filter')
const producerSource = require('./producer')

module.exports = createMessagingIntegration({
  configure: config => ({ ...config, producerFilter: getFilter(config) }),
  id: 'bullmq',
  operations: [
    {
      adapter: 'produce',
      operation: 'messaging.produce',
      source: producerSource,
    },
    {
      adapter: 'consume',
      operation: 'messaging.consume',
      source: consumerSource,
    },
  ],
})
