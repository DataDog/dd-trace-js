'use strict'

module.exports = [
  {
    module: { name: 'hapi', versionRange: '16', filePath: 'lib/request.js' },
    astQuery: 'BlockStatement > ExpressionStatement[expression.left.object.type="ThisExpression"]' +
      '[expression.left.property.name="paramsArray"][expression.right.left.object.name="match"]' +
      '[expression.right.left.property.name="paramsArray"]',
    transform: 'publishHapiRoute',
    channelName: 'routeLookup',
  },
  ...[['hapi', '>=17'], ['@hapi/hapi', '>=17.9']].map(([name, versionRange]) => ({
    module: { name, versionRange, filePath: 'lib/request.js' },
    functionQuery: { methodName: '_lookup', kind: 'Sync' },
    channelName: 'routeLookup',
  })),
]
