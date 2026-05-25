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
    functionQuery: {
      className: 'Dispatcher',
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
    functionQuery: {
      className: 'Dispatcher',
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
    functionQuery: {
      className: 'ProcessHost',
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
    astQuery: 'AssignmentExpression[left.name="Page2"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[kind="method"][key.name="goto"] > FunctionExpression[async], ' +
      'VariableDeclarator[id.name="Page2"] > ClassExpression > ClassBody > ' +
      'MethodDefinition[kind="method"][key.name="goto"] > FunctionExpression[async], ' +
      'ClassDeclaration[id.name="Page2"] > ClassBody > ' +
      'MethodDefinition[kind="method"][key.name="goto"] > FunctionExpression[async]',
    functionQuery: {
      methodName: 'goto',
      kind: 'Async',
    },
    channelName: 'Page_goto',
  },
  {
    module: {
      name: 'playwright-core',
      versionRange: '>=1.60.0',
      filePath: 'lib/coreBundle.js',
    },
    astQuery: 'ReturnStatement > CallExpression[callee.object.name="promise"][callee.property.name="then"]',
    channelName: 'Page_goto',
    transform: 'waitForAsyncEnd',
  },
]
