'use strict'

// Note: FunctionTool.invoke is NOT in this config because FunctionTool is not a class.
// It's a plain object returned by the tool() factory function.
// FunctionTool instrumentation is handled via shimmer in openai-agents.js

module.exports = [
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.3.7',
      filePath: 'dist/run.js'
    },
    functionQuery: {
      methodName: 'run',
      className: 'Runner',
      kind: 'Async'
    },
    channelName: 'Runner_run'
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.3.7',
      filePath: 'dist/openaiChatCompletionsModel.js'
    },
    functionQuery: {
      methodName: 'getResponse',
      className: 'OpenAIChatCompletionsModel',
      kind: 'Async'
    },
    channelName: 'OpenAIChatCompletionsModel_getResponse'
  }
]
