'use strict'

// TODO: Add agent-level LLMObs span (kind: 'agent') wrapping per-agent async execution.
// Python achieves this via add_trace_processor(LLMObsTraceProcessor) which hooks
// Span.start() / Span.end() on the SDK's internal Span class (dist/tracing/spans.js).
// The equivalent here would be hooking Span.prototype.start / Span.prototype.end via
// orchestrion. Requires team sign-off before implementation.

const entries = [
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

// Produce a .mjs twin for every entry so ESM apps get instrumented too.
// The orchestrion rewriter matches file paths exactly — dual-format packages ship
// both dist/*.js (CJS) and dist/*.mjs (ESM), so both need entries.
module.exports = entries.flatMap(entry => [
  entry,
  {
    ...entry,
    module: {
      ...entry.module,
      filePath: entry.module.filePath.replace(/\.js$/, '.mjs'),
    },
  },
])
