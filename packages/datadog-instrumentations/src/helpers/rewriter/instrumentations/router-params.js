'use strict'

const astQuery = 'BlockStatement > :matches(' +
  'ReturnStatement[argument.callee.property.name="process_params"],' +
  'ExpressionStatement[expression.callee.property.name="process_params"],' +
  'ExpressionStatement[expression.callee.name="processParams"])'

module.exports = [
  { name: 'express', versionRange: '>=4.5 <5', filePath: 'lib/router/index.js' },
  { name: 'router', versionRange: '>=1', filePath: 'index.js' },
].map(module => ({ module, astQuery, transform: 'publishRouterParams', channelName: 'routeParams' }))
