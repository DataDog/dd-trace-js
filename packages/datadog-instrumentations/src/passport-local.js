'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapVerify } = require('./passport-utils')

addHook({
  name: 'passport-local',
  file: 'lib/strategy.js',
  versions: ['>=1.0.0']
}, Strategy => {
  return shimmer.wrap(Strategy, function () {
    const type = 'local'

    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false, type)
    } else {
      arguments[1] = wrapVerify(arguments[1], (arguments[0] && arguments[0].passReqToCallback), type)
    }
    return Strategy.apply(this, arguments)
  })
})
