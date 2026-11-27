'use strict'

module.exports = [{
  module: { name: 'fastify', versionRange: '>=3', filePath: 'fastify.js' },
  astQuery: 'FunctionExpression[id.name="preRouting"] > BlockStatement > :first-child',
  transform: 'publishRoutingStart',
  channelName: 'preRouting',
}, {
  module: { name: 'fastify', versionRange: '>=4', filePath: 'fastify.js' },
  astQuery: 'FunctionExpression[id.name="onAsyncConstraintError"] ReturnStatement > ' +
    'CallExpression:matches([callee.name="frameworkErrors"], [callee.property.name="frameworkErrors"])',
  transform: 'scopeRoutingSelection',
  channelName: 'asyncConstraintError',
}]
