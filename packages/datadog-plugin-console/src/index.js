'use strict'

const tx = require('../../dd-trace/src/plugins/util/log')

function createWrapLog (tracer) {
  return function wrapEmit (emit) {
    return function emitWithTrace () {
      const data = tx.correlate(tracer, {})
      let prefix = ''
      if (data.dd !== undefined) {
        prefix = `[dd.trace_id=${data.dd.trace_id} dd.span_id=${data.dd.span_id}]`
      }
      if (arguments.length > 0) {
        arguments[0] = `${prefix} ${arguments[0]}`
      } else {
        arguments[0] = prefix
        arguments.length = 1
      }
      return emit.apply(this, arguments)
    }
  }
}

module.exports = {
  name: 'console',
  global: true,
  patch (cnsole, tracer, _) {
    if (!tracer._logInjection) return
    this.wrap(cnsole, 'log', createWrapLog(tracer))
    this.wrap(cnsole, 'error', createWrapLog(tracer))
    this.wrap(cnsole, 'debug', createWrapLog(tracer))
    this.wrap(cnsole, 'info', createWrapLog(tracer))
  },
  unpatch (cnsole) {
    this.unwrap(cnsole, 'log')
    this.unwrap(cnsole, 'error')
    this.unwrap(cnsole, 'debug')
    this.unwrap(cnsole, 'info')
  }
}
