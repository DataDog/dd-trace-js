const { namingResolver } = require('../../dd-trace/test/plugins/helpers')

module.exports = namingResolver({
  outbound: {
    v0: {
      opName: 'tedious.request',
      serviceName: 'test-mssql'
    },
    v1: {
      opName: 'sqlserver.query',
      serviceName: 'test'
    }
  }
})
