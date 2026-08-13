'use strict'

module.exports = [
  {
    module: {
      name: '@supabase/supabase-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.cjs'
    },
    astQuery: 'VariableDeclarator[id.name="fetchWithAuth"] ReturnStatement > ArrowFunctionExpression[async=true]',
    functionQuery: { kind: 'Async' },
    channelName: 'fetchWithAuth'
  },
  {
    module: {
      name: '@supabase/supabase-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.mjs'
    },
    astQuery: 'VariableDeclarator[id.name="fetchWithAuth"] ReturnStatement > ArrowFunctionExpression[async=true]',
    functionQuery: { kind: 'Async' },
    channelName: 'fetchWithAuth'
  },
  {
    module: {
      name: '@supabase/auth-js',
      versionRange: '2.112.2',
      filePath: 'dist/main/GoTrueClient.js'
    },
    functionQuery: {
      methodName: 'getUser',
      className: 'GoTrueClient',
      kind: 'Async'
    },
    channelName: 'GoTrueClient_getUser'
  },
  {
    module: {
      name: '@supabase/auth-js',
      versionRange: '2.112.2',
      filePath: 'dist/module/GoTrueClient.js'
    },
    functionQuery: {
      methodName: 'getUser',
      className: 'GoTrueClient',
      kind: 'Async'
    },
    channelName: 'GoTrueClient_getUser'
  },
  {
    module: {
      name: '@supabase/storage-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.cjs'
    },
    functionQuery: {
      methodName: 'listBuckets',
      className: 'StorageBucketApi',
      kind: 'Async'
    },
    channelName: 'StorageBucketApi_listBuckets'
  },
  {
    module: {
      name: '@supabase/storage-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'listBuckets',
      className: 'StorageBucketApi',
      kind: 'Async'
    },
    channelName: 'StorageBucketApi_listBuckets'
  },
  {
    module: {
      name: '@supabase/realtime-js',
      versionRange: '2.112.2',
      filePath: 'dist/main/RealtimeChannel.js'
    },
    functionQuery: {
      methodName: 'send',
      className: 'RealtimeChannel',
      kind: 'Async'
    },
    channelName: 'RealtimeChannel_send'
  },
  {
    module: {
      name: '@supabase/realtime-js',
      versionRange: '2.112.2',
      filePath: 'dist/module/RealtimeChannel.js'
    },
    functionQuery: {
      methodName: 'send',
      className: 'RealtimeChannel',
      kind: 'Async'
    },
    channelName: 'RealtimeChannel_send'
  },
  {
    module: {
      name: '@supabase/functions-js',
      versionRange: '2.112.2',
      filePath: 'dist/main/FunctionsClient.js'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'FunctionsClient',
      kind: 'Async'
    },
    channelName: 'FunctionsClient_invoke'
  },
  {
    module: {
      name: '@supabase/functions-js',
      versionRange: '2.112.2',
      filePath: 'dist/module/FunctionsClient.js'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'FunctionsClient',
      kind: 'Async'
    },
    channelName: 'FunctionsClient_invoke'
  },
  {
    module: {
      name: '@supabase/postgrest-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.cjs'
    },
    functionQuery: {
      methodName: 'then',
      className: 'PostgrestBuilder',
      kind: 'Async'
    },
    channelName: 'PostgrestBuilder_then'
  },
  {
    module: {
      name: '@supabase/postgrest-js',
      versionRange: '2.112.2',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'then',
      className: 'PostgrestBuilder',
      kind: 'Async'
    },
    channelName: 'PostgrestBuilder_then'
  }
]
