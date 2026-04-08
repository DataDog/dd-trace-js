'use strict'

function wsServiceName (opts) {
  const { pluginConfig, tracerService } = opts
  if (pluginConfig.service) {
    opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
    return pluginConfig.service
  }
  return tracerService
}

const websocket = {
  request: {
    ws: {
      opName: () => 'web.request',
      serviceName: wsServiceName,
    },
  },
  producer: {
    ws: {
      opName: () => 'websocket.send',
      serviceName: wsServiceName,
    },
  },
  consumer: {
    ws: {
      opName: () => 'websocket.receive',
      serviceName: wsServiceName,
    },
  },
  close: {
    ws: {
      opName: () => 'websocket.close',
      serviceName: wsServiceName,
    },
  },
}

module.exports = websocket
