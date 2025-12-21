'use strict'

const { addHook, getHooks, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const toolInvokeStartCh = channel('tracing:orchestrion:@openai/agents-core:FunctionTool_invoke:asyncStart')
const toolInvokeEndCh = channel('tracing:orchestrion:@openai/agents-core:FunctionTool_invoke:asyncEnd')
const toolInvokeErrorCh = channel('tracing:orchestrion:@openai/agents-core:FunctionTool_invoke:error')

const CLIENT_SYMBOL = Symbol.for('datadog.openai.client')
for (const hook of getHooks(['@openai/agents-core', '@openai/agents-openai'])) {
  addHook(hook, exports => exports)
}

// Wrap OpenAIChatCompletionsModel constructor to capture client reference for peer service
addHook({ name: '@openai/agents-openai', versions: ['>=0.3.7'] }, (moduleExports) => {
  const OriginalModel = moduleExports.OpenAIChatCompletionsModel

  if (typeof OriginalModel !== 'function') {
    return moduleExports
  }

  class WrappedOpenAIChatCompletionsModel extends OriginalModel {
    constructor (client, model) {
      super(client, model)
      this[CLIENT_SYMBOL] = client
      this.model = model
    }
  }

  moduleExports.__ddClientSymbol = CLIENT_SYMBOL

  Object.defineProperty(moduleExports, 'OpenAIChatCompletionsModel', {
    value: WrappedOpenAIChatCompletionsModel,
    writable: true,
    enumerable: true,
    configurable: true
  })

  return moduleExports
})

addHook({ name: '@openai/agents-core', versions: ['>=0.3.7'] }, (moduleExports) => {
  const originalTool = moduleExports.tool
  if (typeof originalTool !== 'function') {
    return moduleExports
  }

  const wrappedTool = function wrappedTool (options) {
    try {
      const toolObj = originalTool.apply(this, arguments)

      if (toolObj && typeof toolObj.invoke === 'function') {
        const originalInvoke = toolObj.invoke
        toolObj.invoke = async function wrappedInvoke (runContext, input, details) {
          if (!toolInvokeStartCh.hasSubscribers) {
            return originalInvoke.apply(this, arguments)
          }

          const ctx = {
            arguments: [runContext, input, details],
            self: toolObj,
            currentStore: {}
          }

          return toolInvokeStartCh.runStores(ctx, async () => {
            try {
              const result = await originalInvoke.apply(this, arguments)
              ctx.result = result

              toolInvokeEndCh.runStores(ctx, () => {})

              return result
            } catch (error) {
              ctx.error = error

              if (toolInvokeErrorCh.hasSubscribers) {
                toolInvokeErrorCh.publish(ctx)
              }

              toolInvokeEndCh.runStores(ctx, () => {})

              throw error
            }
          })
        }
      }

      return toolObj
    } catch (error) {
      return originalTool.apply(this, arguments)
    }
  }

  Object.defineProperty(moduleExports, 'tool', {
    value: wrappedTool,
    writable: true,
    enumerable: true,
    configurable: true
  })
  return moduleExports
})
