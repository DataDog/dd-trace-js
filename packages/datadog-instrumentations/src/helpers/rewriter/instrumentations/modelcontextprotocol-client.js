'use strict'

// SDK 2.x bundles Client into `dist/index` up to 2.3, and into a `public-<hash>` chunk from 2.4.
const filePath = /^dist\/(?:index|public-[\w-]+)\.[cm]js$/
const sourceMatch = 'var Client = class'

const METHODS = [
  'callTool',
  'listTools',
  'listResources',
  'readResource',
  'listPrompts',
  'getPrompt',
]

module.exports = METHODS.map(methodName => ({
  module: { name: '@modelcontextprotocol/client', versionRange: '>=2', filePath, sourceMatch },
  functionQuery: { methodName, className: 'Client', kind: 'Async' },
  channelName: `Client_${methodName}`,
}))
