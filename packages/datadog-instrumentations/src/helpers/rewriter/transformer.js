'use strict'

const transforms = require('./transforms')

function transform (state, ...args) {
  const operator = state.operator = getOperator(state)

  transforms[operator](state, ...args)
}

function getOperator ({ functionQuery: { kind } }) {
  switch (kind) {
    case 'Async': return 'tracePromise'
    case 'AsyncIterator': return 'traceAsyncIterator'
    case 'Callback': return 'traceCallback'
    case 'Iterator': return 'traceIterator'
    case 'Sync': return 'traceSync'
  }
}

module.exports = { transform }
