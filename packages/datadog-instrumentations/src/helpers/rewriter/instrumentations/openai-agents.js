'use strict'

// The openai-agents integration is driven by `@openai/agents-core`'s own
// TracingProcessor interface — see
// `packages/datadog-plugin-openai-agents/src/processor.js` and the classic
// `addHook` in `packages/datadog-instrumentations/src/openai-agents.js`.
//
// The only remaining orchestrion entries are the Python supplement for
// per-turn agent-manifest tagging: `AgentRunner._runSingleTurn` and
// `_runSingleTurnStreamed`. The processor covers every other span the SDK
// creates.

module.exports = [
  // @openai/agents-core — CJS
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.js',
    },
    functionQuery: {
      methodName: '_runSingleTurn',
      className: 'AgentRunner',
      kind: 'Async',
    },
    channelName: 'runSingleTurn',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.js',
    },
    functionQuery: {
      methodName: '_runSingleTurnStreamed',
      className: 'AgentRunner',
      kind: 'Async',
    },
    channelName: 'runSingleTurnStreamed',
  },

  // @openai/agents-core — ESM
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.mjs',
    },
    functionQuery: {
      methodName: '_runSingleTurn',
      className: 'AgentRunner',
      kind: 'Async',
    },
    channelName: 'runSingleTurn',
  },
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.7.0',
      filePath: 'dist/run.mjs',
    },
    functionQuery: {
      methodName: '_runSingleTurnStreamed',
      className: 'AgentRunner',
      kind: 'Async',
    },
    channelName: 'runSingleTurnStreamed',
  },
]
