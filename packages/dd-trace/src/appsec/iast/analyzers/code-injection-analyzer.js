'use strict'

const { CODE_INJECTION } = require('../vulnerabilities')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')
const { INSTRUMENTED_SINK } = require('../telemetry/iast-metric')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')

class CodeInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(CODE_INJECTION)
    this.evalInstrumentedInc = false
  }

  onConfigure () {
    this.addSub('datadog:eval:call', ({ script }) => {
      if (!this.evalInstrumentedInc) {
        const store = storage('legacy').getStore()
        const iastContext = getIastContext(store)
        const tags = INSTRUMENTED_SINK.formatTags(CODE_INJECTION)

        for (const tag of tags) {
          INSTRUMENTED_SINK.inc(iastContext, tag)
        }

        this.evalInstrumentedInc = true
      }

      this.analyze(script)
    })
    this.addSub('datadog:vm:run-script:start', ({ code }) => this.analyze(code))
    this.addSub('datadog:vm:source-text-module:start', ({ code }) => this.analyze(code))
  }
}

module.exports = new CodeInjectionAnalyzer()
