'use strict'

module.exports = [
  {
    module: {
      name: 'mqtt',
      versionRange: '>=5.15.0',
      filePath: 'build/lib/client.js',
    },
    astQuery: 'ClassBody > [key.name="publish"] > FunctionExpression',
    functionQuery: {
      kind: 'Callback',
      index: -1,
    },
    channelName: 'publish',
  },
  {
    module: {
      name: 'mqtt',
      versionRange: '>=5.15.0',
      filePath: 'build/lib/client.js',
    },
    astQuery: 'ClassBody > [key.name="publishAsync"] > FunctionExpression',
    functionQuery: {
      kind: 'Async',
    },
    channelName: 'publishAsync',
  },
  {
    module: {
      name: 'mqtt',
      versionRange: '>=5.15.0',
      filePath: 'build/lib/handlers/publish.js',
    },
    astQuery: 'VariableDeclarator[id.name="handlePublish"] > ArrowFunctionExpression',
    functionQuery: {
      kind: 'Callback',
      index: -1,
    },
    channelName: 'handlePublish',
  },
  {
    module: {
      name: 'mqtt',
      versionRange: '>=5.15.0',
      filePath: 'build/lib/handlers/pubrel.js',
    },
    astQuery: 'VariableDeclarator[id.name="handlePubrel"] > ArrowFunctionExpression',
    functionQuery: {
      kind: 'Callback',
      index: -1,
    },
    channelName: 'handlePubrel',
  },
]
