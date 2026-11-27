'use strict'

const load = {
  module: {
    name: 'dataloader',
    versionRange: '>=2.0.0',
    filePath: 'index.js',
  },
  functionQuery: {
    objectName: '_proto',
    propertyName: 'load',
    kind: 'Async',
  },
  channelName: 'DataLoader_load',
}

module.exports = [
  load,
  {
    module: {
      name: 'dataloader',
      versionRange: '>=2.0.0',
      filePath: 'index.js',
    },
    functionQuery: {
      objectName: '_proto',
      propertyName: 'loadMany',
      kind: 'Async',
    },
    channelName: 'DataLoader_loadMany',
  },
  { ...load, transform: 'configureDataloaderFastPath' },
]
