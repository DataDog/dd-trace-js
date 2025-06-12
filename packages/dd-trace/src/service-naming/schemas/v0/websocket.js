const { identityService } = require('../util')

const websocket = {
  consumer: {
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
  }
}

module.exports = websocket
