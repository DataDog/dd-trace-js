'use strict'

const entries = []
for (const extension of ['js', 'mjs']) {
  for (const [channelName, functionQuery] of [
    ['constructor', { methodName: 'constructor', kind: 'Sync' }],
    ['connect', { methodName: 'connect', kind: 'Async' }],
    ['send', { privateMethodName: 'sendEventNow', kind: 'Sync' }],
    ['close', { methodName: 'close', kind: 'Sync' }],
  ]) {
    entries.push({
      module: {
        name: '@openai/agents-realtime',
        versionRange: '>=0.20.0 <0.21.0',
        filePath: 'dist/openaiRealtimeWebsocket.' + extension,
      },
      functionQuery: { className: 'OpenAIRealtimeWebSocket', ...functionQuery },
      channelName,
    })
  }
}

module.exports = entries
