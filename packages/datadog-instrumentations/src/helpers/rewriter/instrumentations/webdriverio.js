'use strict'

module.exports = [
  {
    module: {
      name: '@wdio/cli',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'Launcher',
      methodName: '_startInstance',
      kind: 'Async',
    },
    channelName: 'Launcher_startInstance',
  },
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
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineAdapter',
      methodName: 'init',
      kind: 'Async',
    },
    channelName: 'JasmineAdapter_init',
  },
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineAdapter',
      methodName: 'run',
      kind: 'Async',
    },
    channelName: 'JasmineAdapter_run',
  },
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="JasmineAdapter"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="run"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"], ' +
      'ClassDeclaration[id.name="JasmineAdapter"] > ClassBody > MethodDefinition[key.name="run"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"]',
    channelName: 'JasmineAdapter_run',
    transform: 'waitForAsyncEnd',
  },
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineReporter',
      methodName: 'specDone',
      kind: 'Sync',
    },
    channelName: 'JasmineReporter_specDone',
  },
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineReporter',
      methodName: 'specStarted',
      kind: 'Sync',
    },
    channelName: 'JasmineReporter_specStarted',
  },
  {
    module: {
      name: '@wdio/utils',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      expressionName: 'testFrameworkFnWrapper',
      kind: 'Async',
    },
    channelName: 'testFrameworkFnWrapper',
  },
]
