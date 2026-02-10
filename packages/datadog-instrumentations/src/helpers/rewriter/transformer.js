'use strict'

const transforms = require('./transforms')

function transform (state, ...args) {
  const operator = state.operator = getOperator(state)

  transforms[operator](state, ...args)
}

function getOperator ({ functionQuery: { kind } }) {
  switch (kind) {
    case 'Async': return 'tracePromise'
    case 'AsyncGenerator': return 'traceAsyncGenerator'
    case 'Callback': return 'traceCallback'
    case 'Generator': return 'traceGenerator'
    case 'Sync': return 'traceSync'
  }
}

module.exports = { transform }
