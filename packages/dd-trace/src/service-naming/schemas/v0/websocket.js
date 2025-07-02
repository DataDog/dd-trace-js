const { identityService } = require('../util')

const ws = {
  consumer: {
    ws: {
      opName: () => 'websocket.request',
      serviceName: identityService
    }
  },
  producer: {
    ws: {
      opName: () => 'websocket.send',
      serviceName: identityService
    }
  },
  receiver: {
    ws: {
      opName: () => 'websocket.send',
      serviceName: identityService
    }
  }
}

module.exports = ws
