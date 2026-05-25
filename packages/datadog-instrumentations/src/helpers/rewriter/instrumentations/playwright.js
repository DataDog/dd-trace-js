'use strict'

// Playwright 1.60 bundles several former hook targets into local classes/functions.
// Keep these rewrites limited to private bundled internals that addHook cannot wrap.
module.exports = [
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.60.0',
      filePath: 'lib/runner/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="Dispatcher"] > ClassExpression, ClassDeclaration[id.name="Dispatcher"]' +
      ' > ClassBody > MethodDefinition[kind="method"][key.name="run"] > FunctionExpression[async]',
    functionQuery: {
      methodName: 'run',
      kind: 'Async',
    },
    channelName: 'Dispatcher_run',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.60.0',
      filePath: 'lib/runner/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="Dispatcher"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="_createWorker"] > FunctionExpression',
    functionQuery: {
      methodName: '_createWorker',
      kind: 'Sync',
    },
    channelName: 'Dispatcher_createWorker',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.60.0',
      filePath: 'lib/runner/index.js',
    },
    astQuery: 'VariableDeclarator[id.name="ProcessHost"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[key.name="startRunner"] > FunctionExpression[async]',
    functionQuery: {
      methodName: 'startRunner',
      kind: 'Async',
    },
    channelName: 'ProcessHost_startRunner',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.60.0',
      filePath: 'lib/runner/index.js',
    },
    functionQuery: {
      functionName: 'createRootSuite',
      kind: 'Async',
    },
    channelName: 'createRootSuite',
  },
  {
    module: {
      name: 'playwright-core',
      versionRange: '>=1.60.0',
      filePath: 'lib/coreBundle.js',
    },
    astQuery: 'AssignmentExpression[left.name="Page2"] > ClassExpression, ' +
      'VariableDeclarator[id.name="Page2"] > ClassExpression, '+
      'ClassDeclaration[id.name="Page2"]' +
      ' > ClassBody > MethodDefinition[kind="method"][key.name="goto"] > FunctionExpression[async]',
    functionQuery: {
      methodName: 'goto',
      kind: 'Async',
    },
    channelName: 'Page_goto',
    transform: 'tracePromiseWithAsyncEnd',
  },
]
