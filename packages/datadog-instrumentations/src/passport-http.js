'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapVerify } = require('./passport-utils')

addHook({
  name: 'passport-http',
  file: 'lib/passport-http/strategies/basic.js',
  versions: ['>=0.3.0']
}, BasicStrategy => {
  return shimmer.wrap(BasicStrategy, function () {
    const type = 'http'

    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false, type)
    } else {
      arguments[1] = wrapVerify(arguments[1], (arguments[0] && arguments[0].passReqToCallback), type)
    }
    return BasicStrategy.apply(this, arguments)
  })
})
