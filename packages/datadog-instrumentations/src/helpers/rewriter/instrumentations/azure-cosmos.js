module.exports = [{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/browser/plugins/Plugin.js'  // file containing the target method
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async'  // Async | Callback | Sync
  },
  channelName: 'executePlugins'
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/commonjs/plugins/Plugin.js'  // file containing the target method
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async'  // Async | Callback | Sync
  },
  channelName: 'executePlugins'
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/esm/plugins/Plugin.js'  // file containing the target method
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async'  // Async | Callback | Sync
  },
  channelName: 'executePlugins'
},
{
  module: {
    name: '@azure/cosmos',
    versionRange: '>=4.4.0',
    filePath: 'dist/react-native/plugins/Plugin.js'  // file containing the target method
  },
  functionQuery: {
    functionName: 'executePlugins',
    kind: 'Async'  // Async | Callback | Sync
  },
  channelName: 'executePlugins'
}]
