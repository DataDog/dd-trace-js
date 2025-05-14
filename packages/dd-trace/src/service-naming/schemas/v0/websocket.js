const { identityService } = require('../util')

const websocket = {
  consumer: {
    ws: {
      opName: () => 'ws.request',
      serviceName: identityService
    }
  },
  producer: {
    ws: {
      opName: () => 'ws.request',
      serviceName: identityService
    }
  }
}

module.exports = websocket
