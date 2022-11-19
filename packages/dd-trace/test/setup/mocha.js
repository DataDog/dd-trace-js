'use strict'

require('./core')

const metrics = require('../../src/metrics')
const agent = require('../plugins/agent')
const { storage } = require('../../../datadog-core')

exports.mochaHooks = {
  afterEach () {
    agent.reset()
    metrics.stop()
    storage.enterWith(undefined)
  }
}
