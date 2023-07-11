'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { SSRF } = require('../vulnerabilities')

class SSRFAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(SSRF)
  }

  onConfigure () {
    this.addSub('apm:http:client:request:start', ({ args }) => {
      if (typeof args.originalUrl === 'string') {
        this.analyze(args.originalUrl)
      } else if (args.options && args.options.host) {
        this.analyze(args.options.host)
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
