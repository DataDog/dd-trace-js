'use strict'

const versions = '>=2 <2.3'

module.exports = [{
  module: { name: 'router', versionRange: versions, filePath: 'lib/layer.js' },
  astQuery: 'AssignmentExpression[left.object.object.name="Layer"][left.property.name="match"] ' +
    'WhileStatement[test.left.argument.name="match"][test.right.right.property.name="length"]',
  transform: 'publishRouterMatch',
  channelName: 'routeMatch',
}, {
  module: { name: 'router', versionRange: versions, filePath: 'index.js' },
  astQuery: 'AssignmentExpression[left.object.object.name="Router"][left.property.name="handle"] ' +
    'FunctionDeclaration[id.name="next"] > BlockStatement > ' +
    'ExpressionStatement[expression.callee.name="processParams"]',
  transform: 'publishRouterMatch',
  channelName: 'routeMatch',
}]
