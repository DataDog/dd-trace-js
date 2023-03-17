function identityService (ddService) {
  return ddService
}

module.exports = {
  messaging: {
    outbound: {
      rhea: {
        opName: () => 'amqp.send',
        serviceName: identityService
      }
    },
    inbound: {
      rhea: {
        opName: () => 'amqp.process',
        serviceName: identityService
      }
    }
  }
}
