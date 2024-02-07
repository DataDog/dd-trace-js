// eslint-disable-next-line
require('dd-trace').init({
  service: 'dd-trace-bad-init'
})

// eslint-disable-next-line import/no-extraneous-dependencies
module.exports = require('jest-environment-node')
