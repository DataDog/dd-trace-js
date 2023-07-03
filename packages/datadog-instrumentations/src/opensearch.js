'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { createWrapRequest, createWrapGetConnection } = require('./elasticsearch')

addHook({ name: '@opensearch-project/opensearch', file: 'lib/Transport.js', versions: ['>=1'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', createWrapRequest('opensearch'))
  shimmer.wrap(Transport.prototype, 'getConnection', createWrapGetConnection('opensearch'))
  return Transport
})
