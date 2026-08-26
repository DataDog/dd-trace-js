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
      name: '@wdio/runner',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'BaseReporter',
      methodName: 'waitForSync',
      kind: 'Async',
    },
    channelName: 'BaseReporter_waitForSync',
  },
  {
    module: {
      name: '@wdio/runner',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="BaseReporter"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="waitForSync"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"], ' +
      'ClassDeclaration[id.name="BaseReporter"] > ClassBody > ' +
      'MethodDefinition[key.name="waitForSync"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"]',
    channelName: 'BaseReporter_waitForSync',
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
    astQuery: 'VariableDeclarator[id.name="JasmineAdapter"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="init"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"], ' +
      'ClassDeclaration[id.name="JasmineAdapter"] > ClassBody > MethodDefinition[key.name="init"] ReturnStatement > ' +
      'CallExpression[callee.object.name="promise"][callee.property.name="then"]',
    channelName: 'JasmineAdapter_init',
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
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineReporter',
      methodName: 'suiteStarted',
      kind: 'Sync',
    },
    channelName: 'JasmineReporter_suiteStarted',
  },
  {
    module: {
      name: '@wdio/jasmine-framework',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      className: 'JasmineReporter',
      methodName: 'suiteDone',
      kind: 'Sync',
    },
    channelName: 'JasmineReporter_suiteDone',
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
  {
    module: {
      name: '@wdio/utils',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    functionQuery: {
      functionName: 'executeAsync',
      kind: 'Async',
    },
    channelName: 'executeAsync',
  },
  {
    module: {
      name: '@wdio/utils',
      versionRange: '>=9.0.0',
      filePath: 'build/index.js',
    },
    astQuery: 'FunctionDeclaration[id.name="executeAsync"] CatchClause ' +
      'IfStatement[test.operator=">"][test.left.object.name="retries"]' +
      '[test.left.property.name="limit"][test.right.object.name="retries"]' +
      '[test.right.property.name="attempts"]',
    channelName: 'executeAsync',
    transform: 'awaitContextCallback',
    transformOptions: {
      callbackArgumentNames: ['err'],
      callbackName: 'retryCallback',
    },
  },
  {
    module: {
      name: 'jasmine-core',
      versionRange: '>=5.0.0 <6.0.0',
      filePath: 'lib/jasmine-core/jasmine.js',
    },
    astQuery: 'AssignmentExpression[left.object.object.name="Spec"]' +
      '[left.object.property.name="prototype"][left.property.name="execute"] > FunctionExpression',
    functionQuery: {
      kind: 'Sync',
    },
    channelName: 'Spec_execute',
  },
  {
    module: {
      name: 'jasmine-core',
      versionRange: '>=5.0.0 <6.0.0',
      filePath: 'lib/jasmine-core/jasmine.js',
    },
    astQuery: 'AssignmentExpression[left.object.object.name="Spec"]' +
      '[left.object.property.name="prototype"][left.property.name="status"] > FunctionExpression',
    functionQuery: {
      kind: 'Sync',
    },
    channelName: 'Spec_attemptDone',
  },
  {
    module: {
      name: 'jasmine-core',
      versionRange: '>=5.0.0 <6.0.0',
      filePath: 'lib/jasmine-core/jasmine.js',
    },
    functionQuery: {
      className: 'Spec',
      methodName: 'executionFinished',
      kind: 'Sync',
    },
    channelName: 'Spec_attemptDone',
  },
  {
    module: {
      name: 'jasmine-core',
      versionRange: '>=5.0.0 <6.0.0',
      filePath: 'lib/jasmine-core/jasmine.js',
    },
    functionQuery: {
      className: 'TreeRunner',
      methodName: '_executeSpec',
      kind: 'Sync',
    },
    channelName: 'Spec_execute',
  },
]
