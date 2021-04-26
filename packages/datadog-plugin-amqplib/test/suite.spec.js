'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('amqplib test suite', () => {
    suiteTest('amqplib', 'squaremo/amqp.node', 'latest')
  })
})
