'use strict'

const entries = []

for (const format of ['esm', 'cjs']) {
  const module = {
    name: '@google/adk',
    versionRange: '>=2.0.0',
  }

  entries.push(
    {
      module: { ...module, filePath: `dist/${format}/runner/runner.js` },
      functionQuery: {
        className: '_Runner',
        methodName: 'runAsync',
        kind: 'Sync',
        returnKind: 'AsyncIterator',
      },
      channelName: 'Runner_runAsync',
    },
    {
      module: { ...module, filePath: `dist/${format}/runner/runner.js` },
      functionQuery: {
        className: '_Runner',
        methodName: 'runLive',
        kind: 'Sync',
        returnKind: 'AsyncIterator',
      },
      channelName: 'Runner_runLive',
    },
    {
      module: { ...module, filePath: `dist/${format}/agents/functions.js` },
      functionQuery: {
        functionName: 'callToolAsync',
        kind: 'Async',
      },
      channelName: 'callToolAsync',
    },
    {
      module: { ...module, filePath: `dist/${format}/code_executors/unsafe_local_code_executor.js` },
      functionQuery: {
        className: '_UnsafeLocalCodeExecutor',
        methodName: 'executeCode',
        kind: 'Async',
      },
      channelName: 'executeCode',
    },
    {
      module: { ...module, filePath: `dist/${format}/code_executors/agent_engine_sandbox_code_executor.js` },
      functionQuery: {
        className: 'AgentEngineSandboxCodeExecutor',
        methodName: 'executeCode',
        kind: 'Async',
      },
      channelName: 'executeCode',
    }
  )
}

module.exports = entries
