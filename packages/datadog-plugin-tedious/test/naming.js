const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  client: {
    v0: {
      opName: 'tedious.request',
      serviceName: 'test-mssql'
    }
  }
})
