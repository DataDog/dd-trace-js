'use strict'
const InjectionAnalyzer = require('./injection-analyzer')

class SqlInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('SQL_INJECTION')
  }

  onConfigure () {
    this.addSub(
      { channelName: 'apm:mysql:query:start' },
      ({ sql }) => this.analyze(sql)
    )
    this.addSub(
      { channelName: 'apm:mysql2:query:start' },
      ({ sql }) => this.analyze(sql)
    )
    this.addSub(
      { channelName: 'apm:pg:query:start' },
      ({ query }) => this.analyze(query.text)
    )
  }
}

module.exports = new SqlInjectionAnalyzer()
