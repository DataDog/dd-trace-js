'use strict'

const { Module, createRequire } = require('node:module')

/** @param {string} sdkPath */
module.exports = function stubHttpClient (sdkPath) {
  const sdkRequire = createRequire(sdkPath)
  const clientPath = sdkRequire.resolve('../../../../Client.js')
  // Conversation eagerly loads the HTTP client even in unauthenticated sessions.
  const previousModules = [clientPath, sdkPath, sdkRequire.resolve('./Conversation.js')]
    .map(filename => [filename, require.cache[filename]])

  const client = new Module(clientPath)
  client.exports = { ElevenLabsClient: class {} }
  client.loaded = true
  require.cache[clientPath] = client

  return () => {
    for (const [filename, previous] of previousModules) {
      if (previous === undefined) {
        delete require.cache[filename]
      } else {
        require.cache[filename] = previous
      }
    }
  }
}
