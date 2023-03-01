// eslint-disable-next-line
require('dd-trace').init({
  service: 'dd-trace-bad-init'
})

module.exports = require('jest-environment-node')
