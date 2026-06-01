'use strict'
const { optionServiceSource } = require('../util')

const websocket = {
  request: {
    ws: {
      opName: () => 'web.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
  },
  producer: {
    ws: {
      opName: () => 'websocket.send',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
  },
  consumer: {
    ws: {
      opName: () => 'websocket.receive',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
  },
  close: {
    ws: {
      opName: () => 'websocket.close',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
  },
}

module.exports = websocket
