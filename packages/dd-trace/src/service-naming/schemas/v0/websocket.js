'use strict'

const websocket = {
  request: {
    ws: {
      opName: () => 'websocket.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    }
  },
  producer: {
    ws: {
      opName: () => 'websocket.send',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    }
  },
  consumer: {
    ws: {
      opName: () => 'websocket.receive',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    }
  },
  close: {
    ws: {
      opName: () => 'websocket.close',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    }
  }
}

module.exports = websocket
