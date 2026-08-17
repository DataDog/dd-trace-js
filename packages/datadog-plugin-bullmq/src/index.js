'use strict'

const { createIntegrationPlugin } = require('../../dd-trace/src/plugins/integration-pipeline')
const { getFilter } = require('./filter')
const producerOperations = require('./producer')
const consumerOperation = require('./consumer')

module.exports = createIntegrationPlugin({
  id: 'bullmq',
  configure: config => ({ ...config, producerFilter: getFilter(config) }),
  operations: [...producerOperations, consumerOperation],
})
