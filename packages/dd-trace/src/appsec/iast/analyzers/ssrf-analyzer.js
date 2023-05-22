'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { SSRF } = require('../vulnerabilities')

class SSRFAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(SSRF)

    this.addSub('apm:http:client:request:start', ({ originalUrlAndOptions }) => {
      if (originalUrlAndOptions.wholeUrl) {
        this.analyze(originalUrlAndOptions.wholeUrl)
      } else if (originalUrlAndOptions.options && originalUrlAndOptions.options.host) {
        this.analyze(originalUrlAndOptions.options.host)
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
