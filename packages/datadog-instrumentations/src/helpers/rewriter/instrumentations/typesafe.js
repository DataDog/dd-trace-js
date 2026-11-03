'use strict'

const name = '@typesafe-ai/sdk'
const versionRange = '>=0.6.0'
const files = ['dist/index.cjs', 'dist/index.mjs']

const targets = [
  {
    // Sync, although it returns a promise: the SDK's `APIPromise` subclass must reach the caller unchanged
    functionQuery: { className: 'TypeSafeClient', methodName: 'systemOne', kind: 'Sync' },
    channelName: 'TypeSafeClient_systemOne',
  },
  {
    functionQuery: { className: 'APIPromise', methodName: 'constructor', kind: 'Sync' },
    channelName: 'APIPromise_constructor',
  },
]

module.exports = files.flatMap(filePath => targets.map(({ functionQuery, channelName }) => ({
  module: { name, versionRange, filePath },
  functionQuery,
  channelName,
})))
