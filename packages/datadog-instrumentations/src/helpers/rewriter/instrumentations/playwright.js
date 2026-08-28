'use strict'

// Playwright keeps several hook targets in private local classes/functions.
// Keep these rewrites limited to bundled internals that addHook cannot wrap.
module.exports = [
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.38.0',
      filePath: 'lib/index.js',
    },
    astQuery: 'CallExpression[callee.object.object.name="testInfo"]' +
      '[callee.object.property.name="attachments"][callee.property.name="push"] > ' +
      'ObjectExpression:has(Property[key.name="name"][value.value="video"])',
    channelName: 'AutomaticVideoAttachment',
    transform: 'markPlaywrightAutomaticVideoAttachment',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.38.0 <1.60.0',
      filePath: 'lib/worker/testInfo.js',
    },
    astQuery: 'ClassDeclaration[id.name="TestInfoImpl"] MethodDefinition[key.name="_attach"] ' +
      'CallExpression[callee.object.type="ThisExpression"][callee.property.name="_onAttach"] > ObjectExpression, ' +
      'ClassDeclaration[id.name="TestInfoImpl"] MethodDefinition[key.name="_attach"] ' +
      'CallExpression[callee.object.object.type="ThisExpression"]' +
      '[callee.object.property.name="_callbacks"][callee.property.name="onAttach"] > ObjectExpression',
    channelName: 'AutomaticVideoAttachmentPayload',
    transform: 'propagatePlaywrightAutomaticVideoAttachment',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.60.0',
      filePath: 'lib/worker/workerProcessEntry.js',
    },
    astQuery: 'VariableDeclarator[id.name="TestInfoImpl"] > ClassExpression ' +
      'MethodDefinition[key.name="_attach"] CallExpression[callee.object.object.type="ThisExpression"]' +
      '[callee.object.property.name="_callbacks"][callee.property.name="onAttach"] > ObjectExpression',
    channelName: 'AutomaticVideoAttachmentPayload',
    transform: 'propagatePlaywrightAutomaticVideoAttachment',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.38.0 <1.51.0',
      filePath: 'lib/index.js',
    },
    functionQuery: {
      className: 'ArtifactsRecorder',
      methodName: '_createScreenshotAttachmentPath',
      kind: 'Sync',
    },
    channelName: 'ArtifactsRecorder_createScreenshotAttachmentPath',
  },
  {
    module: {
      name: 'playwright',
      versionRange: '>=1.51.0',
      filePath: 'lib/index.js',
    },
    functionQuery: {
      className: 'SnapshotRecorder',
      methodName: '_createAttachmentPath',
      kind: 'Sync',
    },
    channelName: 'SnapshotRecorder_createAttachmentPath',
  },
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
