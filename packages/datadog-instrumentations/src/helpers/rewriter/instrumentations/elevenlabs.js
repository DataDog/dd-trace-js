'use strict'

// The published Node SDK is CommonJS; ESM imports resolve to these same files.
module.exports = [
  ...['startSession', '_onWebSocketOpen', '_handleMessage', '_onWebSocketClose', 'endSession'].map(methodName => ({
    module: {
      name: '@elevenlabs/elevenlabs-js',
      versionRange: '>=2.75.0 <3',
      filePath: 'api/resources/conversationalAi/conversation/Conversation.js',
    },
    functionQuery: { className: 'Conversation', methodName, kind: methodName === 'startSession' ? 'Async' : 'Sync' },
    channelName: methodName,
  })),
  ...['register', 'executeToolAsync'].map(methodName => ({
    module: {
      name: '@elevenlabs/elevenlabs-js',
      versionRange: '>=2.75.0 <3',
      filePath: 'api/resources/conversationalAi/conversation/ClientTools.js',
    },
    functionQuery: { className: 'ClientTools', methodName },
    channelName: methodName,
  })),
]
