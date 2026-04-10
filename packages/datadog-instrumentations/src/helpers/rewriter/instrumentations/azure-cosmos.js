'use strict'

module.exports = [{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/browser/plugins/Plugin.js',
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async',
  },
  channelName: 'executePlugins',
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/commonjs/plugins/Plugin.js',
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async',
  },
  channelName: 'executePlugins',
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/esm/plugins/Plugin.js',
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async',
  },
  channelName: 'executePlugins',
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/react-native/plugins/Plugin.js',
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async',
  },
  channelName: 'executePlugins',
}]
