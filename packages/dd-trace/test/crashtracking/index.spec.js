'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('crashtracking', () => {
  let crashtracking
  let crashtracker
  let noop
  let config

  beforeEach(() => {
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

  describe('with a working crashtracker', () => {
    beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': crashtracker
      })
    })

    it('should proxy to the crashtracker', () => {
      crashtracking.start(config)
      crashtracking.configure(config)

      sinon.assert.calledWith(crashtracker.start, config)
      sinon.assert.calledWith(crashtracker.configure, config)
    })
  })

  describe('with an erroring crashtracker', () => {
    beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': null,
        './noop': noop
      })
    })

    it('should proxy to the noop', () => {
      crashtracking.start(config)
      crashtracking.configure(config)

      sinon.assert.calledWith(noop.start, config)
      sinon.assert.calledWith(noop.configure, config)
    })
  })

  describe('when in a worker thread', () => {
    let worker

    beforeEach(() => {
      crashtracking = proxyquire('../../src/crashtracking', {
        './crashtracker': null,
        './noop': noop
      })

      worker = new Worker(path.join(__dirname, 'worker.js'))
    })

    it('should proxy to the noop', done => {
      worker.on('error', done)
      worker.on('exit', code => {
        if (code === 0) {
          done()
        } else {
          done(new Error(`Worker stopped with exit code ${code}`))
        }
      })
    })
  })
})
