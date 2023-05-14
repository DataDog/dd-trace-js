'use strict'

const InjectionAnalyzer = require('./injection-analyzer')

class SSRFAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('SSRF')

    this.addSub('apm:http:client:request:start', ({ originalArgs }) => {
      if (originalArgs.wholeUrl) {
        this.analyze(originalArgs.wholeUrl)
      } else if (originalArgs.options && originalArgs.options.host) {
        this.analyze(originalArgs.options.host)
      }
    })

    this.addSub('apm:http2:client:connect:start', ({ authority }) => {
      if (authority && typeof authority === 'string') {
        this.analyze(authority)
      }
    })
  }
}

module.exports = new SSRFAnalyzer()
