'use strict'

module.exports = [
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.js',
    },
    functionQuery: {
      functionName: 'run',
      kind: 'Async',
    },
    channelName: 'run',
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiResponsesModel.js',
    },
    functionQuery: {
      methodName: 'getResponse',
      className: 'OpenAIResponsesModel',
      kind: 'Async',
    },
    channelName: 'getResponse',
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiResponsesModel.js',
    },
    functionQuery: {
      methodName: 'getStreamedResponse',
      className: 'OpenAIResponsesModel',
      kind: 'Async',
    },
    channelName: 'getStreamedResponse',
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiChatCompletionsModel.js',
    },
    functionQuery: {
      methodName: 'getResponse',
      className: 'OpenAIChatCompletionsModel',
      kind: 'Async',
    },
    channelName: 'getResponse',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tool.js',
    },
    functionQuery: {
      functionName: 'invokeFunctionTool',
      kind: 'Async',
    },
    channelName: 'invokeFunctionTool',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/handoff.js',
    },
    functionQuery: {
      functionName: 'onInvokeHandoff',
      kind: 'Async',
    },
    channelName: 'onInvokeHandoff',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/utils/toolGuardrails.js',
    },
    functionQuery: {
      functionName: 'runToolInputGuardrails',
      kind: 'Async',
    },
    channelName: 'runToolInputGuardrails',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/utils/toolGuardrails.js',
    },
    functionQuery: {
      functionName: 'runToolOutputGuardrails',
      kind: 'Async',
    },
    channelName: 'runToolOutputGuardrails',
  },
]
