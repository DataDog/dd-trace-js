'use strict'

module.exports = [
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/genkit-ai.js'
    },
    functionQuery: {
      methodName: 'generate',
      className: 'GenkitAI',
      kind: 'Async'
    },
    channelName: 'GenkitAI_generate'
  },
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/genkit-ai.mjs'
    },
    functionQuery: {
      methodName: 'generate',
      className: 'GenkitAI',
      kind: 'Async'
    },
    channelName: 'GenkitAI_generate'
  },
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/genkit-ai.js'
    },
    functionQuery: {
      methodName: 'generateStream',
      className: 'GenkitAI',
      kind: 'AsyncIterator'
    },
    channelName: 'GenkitAI_generateStream'
  },
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/genkit-ai.mjs'
    },
    functionQuery: {
      methodName: 'generateStream',
      className: 'GenkitAI',
      kind: 'AsyncIterator'
    },
    channelName: 'GenkitAI_generateStream'
  },
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/chat.js'
    },
    functionQuery: {
      methodName: 'send',
      className: 'Chat',
      kind: 'Async'
    },
    channelName: 'Chat_send'
  },
  {
    module: {
      name: '@genkit-ai/ai',
      versionRange: '>=1.33.0',
      filePath: 'lib/chat.mjs'
    },
    functionQuery: {
      methodName: 'send',
      className: 'Chat',
      kind: 'Async'
    },
    channelName: 'Chat_send'
  },
  {
    module: {
      name: '@genkit-ai/core',
      versionRange: '>=1.33.0',
      filePath: 'lib/action.js'
    },
    functionQuery: {
      methodName: 'defineAction',
      kind: 'Async'
    },
    channelName: 'defineAction'
  },
  {
    module: {
      name: '@genkit-ai/core',
      versionRange: '>=1.33.0',
      filePath: 'lib/action.mjs'
    },
    functionQuery: {
      methodName: 'defineAction',
      kind: 'Async'
    },
    channelName: 'defineAction'
  }
]
