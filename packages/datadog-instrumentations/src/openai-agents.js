'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// Channels for tracing
const runnerRunCh = tracingChannel('@openai/agents:Runner_run')
const getResponseCh = tracingChannel('@openai/agents:OpenAIChatCompletionsModel_getResponse')
const getStreamedResponseCh = tracingChannel('@openai/agents:OpenAIChatCompletionsModel_getStreamedResponse')
const toolInvokeCh = tracingChannel('@openai/agents:tool_invoke')
const executeFunctionToolCallsCh = tracingChannel('@openai/agents:executeFunctionToolCalls')
const executeHandoffCallsCh = tracingChannel('@openai/agents:executeHandoffCalls')

// Wrap async method helper
function wrapAsyncMethod (ch, original) {
  return function (...args) {
    if (!ch.start.hasSubscribers) {
      return original.apply(this, args)
    }

    const ctx = {
      thisArg: this,
      arguments: args
    }

    return ch.tracePromise(original, ctx, this, ...args)
  }
}

// Helper to create the tool wrapper
function createToolWrapper (originalTool) {
  return function wrappedTool (config) {
    const toolObj = originalTool.call(this, config)

    // Wrap the invoke method on the created tool object
    if (toolObj && typeof toolObj.invoke === 'function') {
      const originalInvoke = toolObj.invoke
      toolObj.invoke = wrapAsyncMethod(toolInvokeCh, originalInvoke)
    }

    return toolObj
  }
}

// Also hook the @openai/agents main export which re-exports from @openai/agents-core
addHook({
  name: '@openai/agents',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  // Wrap the re-exported run function
  // Use replaceGetter:true because ESM->CJS conversion uses getters for exports
  // Important: shimmer.wrap may return a new object if properties are non-configurable
  if (moduleExports.run) {
    moduleExports = shimmer.wrap(
      moduleExports,
      'run',
      original => wrapAsyncMethod(runnerRunCh, original),
      { replaceGetter: true }
    )
  }
  // Also wrap the re-exported tool function
  if (moduleExports.tool) {
    moduleExports = shimmer.wrap(
      moduleExports,
      'tool',
      createToolWrapper,
      { replaceGetter: true }
    )
  }
  return moduleExports
})

addHook({
  name: '@openai/agents-core',
  file: 'dist/run.js',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  // Wrap the standalone run function (which is what tests use via module.run)
  if (moduleExports.run) {
    shimmer.wrap(moduleExports, 'run', original => wrapAsyncMethod(runnerRunCh, original))
  }
  // Also wrap Runner.prototype.run in case it's used directly
  const Runner = moduleExports.Runner
  if (Runner?.prototype?.run) {
    shimmer.wrap(Runner.prototype, 'run', original => wrapAsyncMethod(runnerRunCh, original))
  }
  return moduleExports
})

addHook({
  name: '@openai/agents-core',
  file: 'dist/tool.js',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  // The SDK's tool() function creates plain objects with an invoke property,
  // not FunctionTool class instances. We need to wrap the tool() function
  // to intercept each created tool and wrap its invoke method.
  // Use replaceGetter:true because ESM->CJS conversion uses getters for exports
  if (moduleExports.tool) {
    moduleExports = shimmer.wrap(moduleExports, 'tool', createToolWrapper, { replaceGetter: true })
  }
  return moduleExports
})

addHook({
  name: '@openai/agents-core',
  file: 'dist/runImplementation.js',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  if (moduleExports.executeFunctionToolCalls) {
    shimmer.wrap(
      moduleExports,
      'executeFunctionToolCalls',
      original => wrapAsyncMethod(executeFunctionToolCallsCh, original)
    )
  }
  if (moduleExports.executeHandoffCalls) {
    shimmer.wrap(
      moduleExports,
      'executeHandoffCalls',
      original => wrapAsyncMethod(executeHandoffCallsCh, original)
    )
  }
  return moduleExports
})

addHook({
  name: '@openai/agents-openai',
  file: 'dist/openaiChatCompletionsModel.js',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  const OpenAIChatCompletionsModel = moduleExports.OpenAIChatCompletionsModel
  if (OpenAIChatCompletionsModel?.prototype?.getResponse) {
    shimmer.wrap(
      OpenAIChatCompletionsModel.prototype,
      'getResponse',
      original => wrapAsyncMethod(getResponseCh, original)
    )
  }
  if (OpenAIChatCompletionsModel?.prototype?.getStreamedResponse) {
    shimmer.wrap(
      OpenAIChatCompletionsModel.prototype,
      'getStreamedResponse',
      original => wrapAsyncMethod(getStreamedResponseCh, original)
    )
  }
  return moduleExports
})

// Hook OpenAIResponsesModel - this is the default model used by OpenAIProvider
addHook({
  name: '@openai/agents-openai',
  file: 'dist/openaiResponsesModel.js',
  versions: ['>=0.3.7']
}, (moduleExports) => {
  const OpenAIResponsesModel = moduleExports.OpenAIResponsesModel
  if (OpenAIResponsesModel?.prototype?.getResponse) {
    shimmer.wrap(
      OpenAIResponsesModel.prototype,
      'getResponse',
      original => wrapAsyncMethod(getResponseCh, original)
    )
  }
  if (OpenAIResponsesModel?.prototype?.getStreamedResponse) {
    shimmer.wrap(
      OpenAIResponsesModel.prototype,
      'getStreamedResponse',
      original => wrapAsyncMethod(getStreamedResponseCh, original)
    )
  }
  return moduleExports
})
