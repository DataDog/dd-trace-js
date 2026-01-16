'use strict'

module.exports = [
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.2.7',
      filePath: 'sdk.mjs'
    },
    functionQuery: {
      methodName: 'query',
      kind: 'Sync'
    },
    channelName: 'query'
  },
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.2.7',
      filePath: 'sdk.mjs'
    },
    functionQuery: {
      methodName: 'unstable_v2_prompt',
      kind: 'Async'
    },
    channelName: 'unstable_v2_prompt'
  },
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.2.7'
    },
    functionQuery: {
      methodName: 'send',
      className: 'SDKSession',
      kind: 'Async'
    },
    channelName: 'SDKSession_send'
  }
]
