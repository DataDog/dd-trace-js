'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class MySQLPlugin extends Plugin {
  static get name () {
    return 'mysql'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.name}:query:start`, ({ sql, conf }) => {
      this.startSpan('mysql.query', {
        service: this.config.service || `${this.tracer.config.service}-mysql`,
        resource: sql,
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': 'mysql',
          'db.user': conf.user,
          'db.name': conf.database,
          'out.host': conf.host,
          'out.port': conf.port
        }
      })
    })

    this.addSub(`apm:${this.constructor.name}:query:end`, () => {
      this.exit()
    })

    this.addSub(`apm:${this.constructor.name}:query:error`, err => {
      this.addError(err)
    })

    this.addSub(`apm:${this.constructor.name}:query:async-end`, () => {
      this.finishSpan()
    })
  }
}

module.exports = MySQLPlugin
