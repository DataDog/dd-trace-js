'use strict'
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/core')

const crashtracker = {
  start: sinon.stub(),
  configure: sinon.stub()
}

const noop = {
  start: sinon.stub(),
  configure: sinon.stub()
}

const crashtracking = proxyquire('../../src/crashtracking', {
  './crashtracker': crashtracker,
  './noop': noop
})

crashtracking.start()
crashtracking.configure()

sinon.assert.called(noop.start)
sinon.assert.called(noop.configure)
