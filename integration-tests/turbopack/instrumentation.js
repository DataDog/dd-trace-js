'use strict'

exports.register = function () {
  if (process.env.NEXT_RUNTIME === 'nodejs') require('dd-trace').init()
}
