'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { createWrapRequest } = require('./elasticsearch')

addHook({ name: '@opensearch-project/opensearch', file: 'lib/Transport.js', versions: ['1.1.0'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', createWrapRequest('opensearch'))
  return Transport
})
