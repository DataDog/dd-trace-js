'use strict'

const { identityService } = require('../util')

const websocket = {
  request: {
    websocket: {
      opName: () => 'websocket.request',
      serviceName: identityService
    }
  },
  producer: {
    websocket: {
      opName: () => 'websocket.send',
      serviceName: identityService
    }
  },
  consumer: {
    websocket: {
      opName: () => 'websocket.receive',
      serviceName: identityService
    }
  },
  close: {
    websocket: {
      opName: () => 'websocket.close',
      serviceName: identityService
    }
  }
}

module.exports = websocket
