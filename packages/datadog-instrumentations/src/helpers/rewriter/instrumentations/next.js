'use strict'

const astQuery = 'MethodDefinition[key.name="handleNextImageRequest"] > FunctionExpression, ' +
  'AssignmentExpression[left.object.type="ThisExpression"]' +
    '[left.property.name="handleNextImageRequest"] > ArrowFunctionExpression, ' +
  'ObjectExpression:has(Property[key.name="name"][value.value="_next/image catchall"])' +
    ' > Property[key.name="fn"] > ArrowFunctionExpression'

module.exports = [
  {
    module: {
      name: 'next',
      versionRange: '>=10.2 <11.1',
      filePath: 'dist/next-server/server/next-server.js',
    },
    functionQuery: { kind: 'Async', index: null },
    astQuery,
    channelName: 'imageRequest',
  },
  {
    module: {
      name: 'next',
      versionRange: '>=11.1 <15.2',
      filePath: 'dist/server/next-server.js',
    },
    functionQuery: { kind: 'Async', index: null },
    astQuery,
    channelName: 'imageRequest',
  },
  {
    module: {
      name: 'next',
      versionRange: '>=15.2',
      filePath: 'dist/server/next-server.js',
    },
    functionQuery: { kind: 'Async', index: null },
    astQuery,
    channelName: 'imageRequestWithMiddleware',
  },
]
