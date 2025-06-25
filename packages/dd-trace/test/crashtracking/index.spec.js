'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const t = require('tap')
require('../setup/core')

t.test('crashtracking', t => {
  let crashtracking
  let crashtracker
  let noop
  let config

  t.beforeEach(() => {
    crashtracker = {
      start: sinon.stub(),
      configure: sinon.stub()
    }

    noop = {
      start: sinon.stub(),
      configure: sinon.stub()
    }

    config = {}
  })

  t.test('with a working crashtracker', t => {
    t.beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': crashtracker
      })
    })

    t.test('should proxy to the crashtracker', t => {
      crashtracking.start(config)
      crashtracking.configure(config)

      expect(crashtracker.start).to.have.been.calledWith(config)
      expect(crashtracker.configure).to.have.been.calledWith(config)
      t.end()
    })
    t.end()
  })

  t.test('with an erroring crashtracker', t => {
    t.beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': null,
        './noop': noop
      })
    })

    t.test('should proxy to the noop', t => {
      crashtracking.start(config)
      crashtracking.configure(config)

      expect(noop.start).to.have.been.calledWith(config)
      expect(noop.configure).to.have.been.calledWith(config)
      t.end()
    })
    t.end()
  })

  t.test('when in a worker thread', t => {
    let worker

    t.beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': null,
        './noop': noop
      })

      worker = new Worker(path.join(__dirname, 'worker.js'))
    })

    t.test('should proxy to the noop', t => {
      worker.on('error', t.error)
      worker.on('exit', code => {
        if (code === 0) {
          t.end()
        } else {
          t.fail(`Worker stopped with exit code ${code}`)
        }
      })
    })
    t.end()
  })
  t.end()
})
