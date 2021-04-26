'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('amqp10 test suite', () => {
    suiteTest('amqp10', 'noodlefrenzy/node-amqp10', 'latest')
  })
})
