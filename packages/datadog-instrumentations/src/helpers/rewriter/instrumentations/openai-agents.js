'use strict'

// TODO: Add agent-level LLMObs span (kind: 'agent') wrapping per-agent async execution.
// Python achieves this via add_trace_processor(LLMObsTraceProcessor) which hooks
// Span.start() / Span.end() on the SDK's internal Span class (dist/tracing/spans.js).
// The equivalent here would be hooking Span.prototype.start / Span.prototype.end via
// orchestrion. Requires team sign-off before implementation.

module.exports = [
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
      kind: 'AsyncIterator',
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
      kind: 'AsyncIterator',
    },
    channelName: 'getStreamedResponse',
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
