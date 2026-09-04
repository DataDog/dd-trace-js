'use strict'

const versionRange = '>=2.112.2 <3'

module.exports = [
  {
    module: {
      name: '@supabase/storage-js',
      versionRange,
      filePath: 'dist/index.cjs',
    },
    functionQuery: { functionName: '_handleRequest', kind: 'Async' },
    channelName: 'handleRequest',
  },
  {
    module: {
      name: '@supabase/storage-js',
      versionRange,
      filePath: 'dist/index.mjs',
    },
    functionQuery: { functionName: '_handleRequest', kind: 'Async' },
    channelName: 'handleRequest',
  },
  {
    module: {
      name: '@supabase/auth-js',
      versionRange,
      filePath: 'dist/main/GoTrueClient.js',
    },
    functionQuery: {
      methodName: 'getUser',
      className: 'GoTrueClient',
      kind: 'Async',
    },
    channelName: 'GoTrueClient_getUser',
  },
  {
    module: {
      name: '@supabase/auth-js',
      versionRange,
      filePath: 'dist/module/GoTrueClient.js',
    },
    functionQuery: {
      methodName: 'getUser',
      className: 'GoTrueClient',
      kind: 'Async',
    },
    channelName: 'GoTrueClient_getUser',
  },
  {
    module: {
      name: '@supabase/realtime-js',
      versionRange,
      filePath: 'dist/main/RealtimeChannel.js',
    },
    functionQuery: {
      methodName: 'send',
      className: 'RealtimeChannel',
      kind: 'Async',
    },
    channelName: 'RealtimeChannel_send',
  },
  {
    module: {
      name: '@supabase/realtime-js',
      versionRange,
      filePath: 'dist/module/RealtimeChannel.js',
    },
    functionQuery: {
      methodName: 'send',
      className: 'RealtimeChannel',
      kind: 'Async',
    },
    channelName: 'RealtimeChannel_send',
  },
  {
    module: {
      name: '@supabase/functions-js',
      versionRange,
      filePath: 'dist/main/FunctionsClient.js',
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'FunctionsClient',
      kind: 'Async',
    },
    channelName: 'FunctionsClient_invoke',
  },
  {
    module: {
      name: '@supabase/functions-js',
      versionRange,
      filePath: 'dist/module/FunctionsClient.js',
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'FunctionsClient',
      kind: 'Async',
    },
    channelName: 'FunctionsClient_invoke',
  },
  {
    module: {
      name: '@supabase/postgrest-js',
      versionRange,
      filePath: 'dist/index.cjs',
    },
    functionQuery: {
      methodName: 'then',
      className: 'PostgrestBuilder',
      kind: 'Async',
    },
    channelName: 'PostgrestBuilder_then',
  },
  {
    module: {
      name: '@supabase/postgrest-js',
      versionRange,
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      methodName: 'then',
      className: 'PostgrestBuilder',
      kind: 'Async',
    },
    channelName: 'PostgrestBuilder_then',
  },
]
