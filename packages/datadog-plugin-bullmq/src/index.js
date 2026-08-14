'use strict'

const { createOrchestrionPlugin } = require('../../dd-trace/src/plugins/orchestrion-pipeline')
const { getFilter } = require('./filter')
const producerOperations = require('./producer')
const consumerOperation = require('./consumer')

module.exports = createOrchestrionPlugin({
  id: 'bullmq',
  configure: config => ({ ...config, producerFilter: getFilter(config) }),
  operations: [...producerOperations, consumerOperation],
})
