'use strict'

if (!process.env.DISABLE_TAP) {
  require('tap').mochaGlobals()
  require('./core')
}
