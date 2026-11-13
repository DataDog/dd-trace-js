'use strict'

// SDK 2.x bundles Client into `dist/index` up to 2.3, and into a `public-<hash>` chunk from 2.4.
const CLIENT_FILES = [
  { versionRange: '>=2 <2.4.0', filePath: /^dist\/index\.[cm]js$/ },
  { versionRange: '>=2.4.0', filePath: /^dist\/public-[\w-]+\.[cm]js$/ },
]

const CLIENT_METHODS = [
  'callTool',
  'listTools',
  'listResources',
  'readResource',
  'listPrompts',
  'getPrompt',
]

module.exports = [
  ...CLIENT_FILES.flatMap(({ versionRange, filePath }) => CLIENT_METHODS.map(methodName => ({
    module: { name: '@modelcontextprotocol/client', versionRange, filePath },
    functionQuery: { methodName, className: 'Client', kind: 'Async' },
    channelName: `Client_${methodName}`,
  }))),
  // Every 2.x release bundles Protocol into a `src-<hash>` chunk.
  {
    module: { name: '@modelcontextprotocol/client', versionRange: '>=2', filePath: /^dist\/src-[\w-]+\.[cm]js$/ },
    functionQuery: { methodName: 'request', className: 'Protocol', kind: 'Sync' },
    channelName: 'Protocol_request',
  },
]
