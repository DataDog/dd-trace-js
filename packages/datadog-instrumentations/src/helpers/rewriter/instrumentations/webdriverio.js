'use strict'

module.exports = [
  {
    module: {
      name: '@wdio/local-runner',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'LocalRunner',
      methodName: 'run',
      kind: 'Async',
    },
    channelName: 'LocalRunner_run',
  },
  {
    module: {
      name: '@wdio/local-runner',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'LocalRunner',
      methodName: 'shutdown',
      kind: 'Async',
    },
    channelName: 'LocalRunner_shutdown',
  },
  {
    module: {
      name: '@wdio/local-runner',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="LocalRunner"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="shutdown"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"], ' +
      'ClassDeclaration[id.name="LocalRunner"] > ClassBody > MethodDefinition[key.name="shutdown"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"]',
    channelName: 'LocalRunner_shutdown',
    transform: 'waitForAsyncEnd',
  },
]
