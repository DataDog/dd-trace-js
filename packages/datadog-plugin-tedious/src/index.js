'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class TediousPlugin extends Plugin {
  static get name () {
    return 'tedious'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:tedious:request:start`, ({ queryOrProcedure, connectionConfig }) => {
      this.startSpan('tedious.request', {
        resource: queryOrProcedure,
        service: this.config.service || `${this.tracer.config.service}-mssql`,
        kind: 'client',
        type: 'sql',
        tags: {
          'db.type': 'mssql',
          'component': 'tedious',
          'out.host': connectionConfig.server,
          'out.port': connectionConfig.options.port,
          'db.user': connectionConfig.userName || connectionConfig.authentication.options.userName,
          'db.name': connectionConfig.options.database,
          'db.instance': connectionConfig.options.instanceName
        }
      })
    })

    this.addSub(`apm:tedious:request:end`, () => {
      this.exit()
    })

    this.addSub(`apm:tedious:request:error`, err => {
      this.activeSpan.addError(err)
    })

    this.addSub(`apm:tedious:request:async-end`, () => {
      this.finishSpan()
    })
  }
}

module.exports = TediousPlugin
