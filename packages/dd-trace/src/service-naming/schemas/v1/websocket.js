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
      opName: () => 'websocket.receive',
      serviceName: identityService
    }
  },
  close: {
    ws: {
      opName: () => 'websocket.close',
      serviceName: identityService
    }
  }
}

module.exports = ws
