'use strict'

module.exports = [
  // @openai/agents-core — MultiTracingProcessor lifecycle (CJS)
  // Used by the agent-span plugin to emit a dd-trace span per agent execution
  // with correct parenting via agents-core's own spanId/parentId chain. Fills
  // the multi-agent handoff gap that the function-level `run` hook cannot cover.
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tracing/processor.js',
    },
    functionQuery: {
      methodName: 'onSpanStart',
      className: 'MultiTracingProcessor',
      kind: 'Async',
    },
    channelName: 'multiProcessorSpanStart',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tracing/processor.js',
    },
    functionQuery: {
      methodName: 'onSpanEnd',
      className: 'MultiTracingProcessor',
      kind: 'Async',
    },
    channelName: 'multiProcessorSpanEnd',
  },

  // @openai/agents-core — CJS
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

  // @openai/agents-core — MultiTracingProcessor lifecycle (ESM)
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tracing/processor.mjs',
    },
    functionQuery: {
      methodName: 'onSpanStart',
      className: 'MultiTracingProcessor',
      kind: 'Async',
    },
    channelName: 'multiProcessorSpanStart',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tracing/processor.mjs',
    },
    functionQuery: {
      methodName: 'onSpanEnd',
      className: 'MultiTracingProcessor',
      kind: 'Async',
    },
    channelName: 'multiProcessorSpanEnd',
  },

  // @openai/agents-core — ESM
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.mjs',
    },
    functionQuery: {
      functionName: 'run',
      kind: 'Async',
    },
    channelName: 'run',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/tool.mjs',
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
      filePath: 'dist/handoff.mjs',
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
      filePath: 'dist/utils/toolGuardrails.mjs',
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
      filePath: 'dist/utils/toolGuardrails.mjs',
    },
    functionQuery: {
      functionName: 'runToolOutputGuardrails',
      kind: 'Async',
    },
    channelName: 'runToolOutputGuardrails',
  },

  // @openai/agents-openai — CJS
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
    },
    channelName: 'getStreamedResponse',
    transform: 'traceAsyncIterator',
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

  // @openai/agents-openai — ESM
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiResponsesModel.mjs',
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
      filePath: 'dist/openaiResponsesModel.mjs',
    },
    functionQuery: {
      methodName: 'getStreamedResponse',
      className: 'OpenAIResponsesModel',
    },
    channelName: 'getStreamedResponse',
    transform: 'traceAsyncIterator',
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiChatCompletionsModel.mjs',
    },
    functionQuery: {
      methodName: 'getResponse',
      className: 'OpenAIChatCompletionsModel',
      kind: 'Async',
    },
    channelName: 'getResponse',
  },
]
