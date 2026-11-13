'use strict'

// SDK 2.x bundles Client into `dist/index` up to 2.3, and into a `public-<hash>` chunk from 2.4.
const FILES = [
  { versionRange: '>=2 <2.4.0', filePath: /^dist\/index\.[cm]js$/ },
  { versionRange: '>=2.4.0', filePath: /^dist\/public-[\w-]+\.[cm]js$/ },
]

const METHODS = [
  'callTool',
  'listTools',
  'listResources',
  'readResource',
  'listPrompts',
  'getPrompt',
]

module.exports = FILES.flatMap(({ versionRange, filePath }) => METHODS.map(methodName => ({
  module: { name: '@modelcontextprotocol/client', versionRange, filePath },
  functionQuery: { methodName, className: 'Client', kind: 'Async' },
  channelName: `Client_${methodName}`,
})))
