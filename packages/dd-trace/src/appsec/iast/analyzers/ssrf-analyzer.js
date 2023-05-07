'use strict'

const InjectionAnalyzer = require('./injection-analyzer')

class SSRFAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('SSRF')

    this.addSub('apm:http:client:request:start', ({ originalArgs }) => {
      if (typeof originalArgs[0] === 'string') {
        this.analyze(originalArgs[0])
      } else if (originalArgs[0] && originalArgs[0].host) {
        this.analyze(originalArgs[0].host)
      }
    })

    this.addSub('apm:http2:client:connect:start', ({ args }) => {
      if (args && typeof args[0] === 'string') {
        this.analyze(args[0])
      }
    })
  }
}

module.exports = new SSRFAnalyzer()
