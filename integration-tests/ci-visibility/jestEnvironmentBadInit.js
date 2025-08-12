'use strict'

require('dd-trace').init({
  service: 'dd-trace-bad-init'
})

module.exports = require('jest-environment-node')
