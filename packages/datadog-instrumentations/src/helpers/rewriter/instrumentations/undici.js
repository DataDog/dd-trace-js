'use strict'

module.exports = [
  {
    module: {
      name: 'undici',
      versionRange: '>=4.7.0 <5.0.0',
      filePath: 'lib/client.js',
    },
    functionQuery: {
      className: 'Client',
      methodName: 'dispatch',
      kind: 'Sync',
    },
    channelName: 'Client_dispatch',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=4.7.0 <5.0.0',
      filePath: 'lib/client.js',
    },
    astQuery: 'ClassBody > MethodDefinition[key.name="dispatch"] > FunctionExpression',
    transform: 'syncNoSubscriberFastPath',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=5.0.0 <6.7.0',
      filePath: 'lib/client.js',
    },
    functionQuery: {
      className: 'Client',
      methodName: 'kDispatch',
      kind: 'Sync',
    },
    channelName: 'Client_dispatch',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=5.0.0 <6.7.0',
      filePath: 'lib/client.js',
    },
    astQuery: 'ClassBody > MethodDefinition[key.name="kDispatch"] > FunctionExpression',
    transform: 'syncNoSubscriberFastPath',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=6.7.0',
      filePath: 'lib/dispatcher/client.js',
    },
    functionQuery: {
      className: 'Client',
      methodName: 'kDispatch',
      kind: 'Sync',
    },
    channelName: 'Client_dispatch',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=6.7.0',
      filePath: 'lib/dispatcher/client.js',
    },
    astQuery: 'ClassBody > MethodDefinition[key.name="kDispatch"] > FunctionExpression',
    transform: 'syncNoSubscriberFastPath',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=4.7.0 <8.0.0',
      filePath: 'lib/core/request.js',
    },
    functionQuery: {
      className: 'Request',
      methodName: 'onUpgrade',
      kind: 'Sync',
    },
    channelName: 'Request_onUpgrade',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=4.7.0 <8.0.0',
      filePath: 'lib/core/request.js',
    },
    astQuery: 'ClassBody > MethodDefinition[key.name="onUpgrade"] > FunctionExpression',
    transform: 'syncNoSubscriberFastPath',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=8.0.0',
      filePath: 'lib/core/request.js',
    },
    functionQuery: {
      className: 'Request',
      methodName: 'onRequestUpgrade',
      kind: 'Sync',
    },
    channelName: 'Request_onUpgrade',
  },
  {
    module: {
      name: 'undici',
      versionRange: '>=8.0.0',
      filePath: 'lib/core/request.js',
    },
    astQuery: 'ClassBody > MethodDefinition[key.name="onRequestUpgrade"] > FunctionExpression',
    transform: 'syncNoSubscriberFastPath',
  },
]
