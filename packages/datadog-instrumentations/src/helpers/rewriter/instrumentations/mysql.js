'use strict'

// mysql ships a single CommonJS build (`lib/*.js`); there is no separate ESM
// output, so each target needs only one entry.
//
// All three targets are anonymous/named `X.prototype.y = function (...) {}`
// AssignmentExpressions. The transformer's `objectName`/`propertyName` selector
// does not match nested prototype assignments, so each entry uses an explicit
// receiver `astQuery` plus `functionQuery` metadata to drive the operator.
module.exports = [
  {
    module: {
      name: 'mysql',
      versionRange: '>=2',
      filePath: 'lib/Connection.js',
    },
    astQuery: "AssignmentExpression[left.object.object.name='Connection']" +
      "[left.object.property.name='prototype'][left.property.name='query'] > FunctionExpression",
    functionQuery: {
      kind: 'Sync',
      propertyName: 'query',
    },
    channelName: 'Connection_query',
  },
  {
    module: {
      name: 'mysql',
      versionRange: '>=2',
      filePath: 'lib/Pool.js',
    },
    astQuery: "AssignmentExpression[left.object.object.name='Pool']" +
      "[left.object.property.name='prototype'][left.property.name='query'] > FunctionExpression",
    functionQuery: {
      kind: 'Sync',
      propertyName: 'query',
    },
    channelName: 'Pool_query',
  },
  {
    module: {
      name: 'mysql',
      versionRange: '>=2',
      filePath: 'lib/Pool.js',
    },
    astQuery: "AssignmentExpression[left.object.object.name='Pool']" +
      "[left.object.property.name='prototype'][left.property.name='getConnection'] > FunctionExpression",
    functionQuery: {
      kind: 'Callback',
      callbackIndex: 0,
      propertyName: 'getConnection',
    },
    channelName: 'Pool_getConnection',
  },
]
