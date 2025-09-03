'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

require('../setup/tap')

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

      expect(crashtracker.start).to.have.been.calledWith(config)
      expect(crashtracker.configure).to.have.been.calledWith(config)
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

      expect(noop.start).to.have.been.calledWith(config)
      expect(noop.configure).to.have.been.calledWith(config)
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
