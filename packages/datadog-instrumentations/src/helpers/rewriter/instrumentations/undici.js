'use strict'

module.exports = [
  ['>=4.4.1 <8.0.0', 'onUpgrade'],
  ['>=8.0.0', 'onRequestUpgrade'],
].map(([versionRange, methodName]) => ({
  module: {
    name: 'undici',
    versionRange,
    filePath: 'lib/core/request.js',
  },
  functionQuery: {
    className: 'Request',
    methodName,
    kind: 'Sync',
  },
  channelName: 'Request_onUpgrade',
}))
