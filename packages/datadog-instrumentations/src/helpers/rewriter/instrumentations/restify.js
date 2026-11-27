'use strict'

module.exports = [{
  module: { name: 'restify', versionRange: '>=5', filePath: 'lib/server.js' },
  astQuery: 'BlockStatement > ExpressionStatement[expression.callee.property.name="emit"]' +
    '[expression.arguments.0.value="routed"][expression.arguments.1.type="Identifier"]',
  transform: 'publishRestifyRoute',
  channelName: 'routeMatch',
}]
