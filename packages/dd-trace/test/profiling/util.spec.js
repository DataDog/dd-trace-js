'use strict'

'use strict'

const expect = require('chai').expect

describe('util', () => {
  let util

  beforeEach(() => {
    util = require('../../src/profiling/util')
  })

  describe('maybeRequire', () => {
    it('should require available modules', () => {
      expect(util.maybeRequire('mocha')).to.be.a('function')
    })

    it('should handle the error for unavailable modules', () => {
      expect(util.maybeRequire('_invalid_')).to.be.null
    })
  })

  describe('eachOfSeries', () => {
    let collection
    let iteratee
    let callback
    let next

    beforeEach(() => {
      collection = ['first', 'second', 'third']
      iteratee = sinon.spy((item, index, callback) => {
        next = callback
      })
      callback = sinon.stub()
      next = null
    })

    it('should run the iteratee for each collection item in sequence', () => {
      util.eachOfSeries(collection, iteratee, callback)

      sinon.assert.calledOnce(iteratee)
      sinon.assert.calledWith(iteratee, 'first', 0)
      sinon.assert.notCalled(callback)

      next(null, 'a')

      sinon.assert.calledTwice(iteratee)
      sinon.assert.calledWith(iteratee, 'second', 1)
      sinon.assert.notCalled(callback)

      next(null, 'b')

      sinon.assert.calledThrice(iteratee)
      sinon.assert.calledWith(iteratee, 'third', 2)
      sinon.assert.notCalled(callback)

      next(null, 'c')

      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, null, ['a', 'b', 'c'])
    })

    it('should fail on the first error', () => {
      const error = new Error('boom')

      util.eachOfSeries(collection, iteratee, callback)

      next(null, 'a')
      next(error)

      sinon.assert.calledTwice(iteratee)
      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, error)
    })
  })

  describe('eachSeries', () => {
    let collection
    let iteratee
    let callback
    let next

    beforeEach(() => {
      collection = ['first', 'second', 'third']
      iteratee = sinon.spy((item, callback) => {
        next = callback
      })
      callback = sinon.stub()
      next = null
    })

    it('should run the iteratee for each collection item in sequence', () => {
      util.eachSeries(collection, iteratee, callback)

      sinon.assert.calledOnce(iteratee)
      sinon.assert.calledWith(iteratee, 'first')
      sinon.assert.notCalled(callback)

      next(null, 'a')

      sinon.assert.calledTwice(iteratee)
      sinon.assert.calledWith(iteratee, 'second')
      sinon.assert.notCalled(callback)

      next(null, 'b')

      sinon.assert.calledThrice(iteratee)
      sinon.assert.calledWith(iteratee, 'third')
      sinon.assert.notCalled(callback)

      next(null, 'c')

      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, null, ['a', 'b', 'c'])
    })

    it('should fail on the first error', () => {
      const error = new Error('boom')

      util.eachSeries(collection, iteratee, callback)

      next(null, 'a')
      next(error)

      sinon.assert.calledTwice(iteratee)
      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, error)
    })
  })

  describe('parallel', () => {
    let tasks
    let callback

    beforeEach(() => {
      tasks = [
        sinon.stub(),
        sinon.stub(),
        sinon.stub()
      ]
      callback = sinon.stub()
    })

    it('should run each task in parallel and preserve result order', () => {
      util.parallel(tasks, callback)

      sinon.assert.notCalled(callback)

      tasks[1].yield(null, 'b')
      tasks[2].yield(null, 'c')
      tasks[0].yield(null, 'a')

      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, null, ['a', 'b', 'c'])
    })

    it('should fail on the first error without waiting for all tasks to complete', () => {
      const error = new Error('boom')

      util.parallel(tasks, callback)

      sinon.assert.notCalled(callback)

      tasks[0].yield(null, 'a')
      tasks[1].yield(error)

      sinon.assert.called(callback)
      sinon.assert.calledWith(callback, error)

      tasks[2].yield(null, 'c')

      sinon.assert.calledOnce(callback)
    })

    it('should ignore further errors when failing', () => {
      const error = new Error('boom')

      util.parallel(tasks, callback)

      tasks[0].yield(error)
      tasks[1].yield(error)
      tasks[2].yield(error)

      sinon.assert.calledOnce(callback)
    })
  })
})
