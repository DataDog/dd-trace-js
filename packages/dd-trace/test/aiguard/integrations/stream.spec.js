'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

class FakeStream {
  constructor (chunks, error, throwSynchronously) {
    this.chunks = chunks
    this.error = error
    this.throwSynchronously = throwSynchronously
  }

  tee () {
    return [
      new FakeStream(this.chunks, this.error, this.throwSynchronously),
      new FakeStream(this.chunks, this.error, this.throwSynchronously),
    ]
  }

  [Symbol.asyncIterator] () {
    let index = 0
    return {
      next: () => {
        if (index < this.chunks.length) {
          return Promise.resolve({ done: false, value: this.chunks[index++] })
        }
        if (this.error) {
          if (this.throwSynchronously) throw this.error
          return Promise.reject(this.error)
        }
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }
}

describe('AIGuard stream interception', () => {
  const chunks = [{ index: 0 }, { index: 1 }]
  let log
  let interceptStream

  beforeEach(() => {
    log = { error: sinon.stub() }
    ;({ interceptStream } = proxyquire('../../../src/aiguard/integrations/stream', {
      '../../log': log,
    }))
  })

  afterEach(() => {
    sinon.restore()
  })

  it('inspects every chunk and returns the delivery branch', async () => {
    const inspect = sinon.stub().resolves()

    const delivered = await interceptStream(new FakeStream(chunks), inspect)

    sinon.assert.calledOnceWithExactly(inspect, chunks)
    sinon.assert.notCalled(log.error)
    assert.ok(delivered instanceof FakeStream)
  })

  for (const [label, throwSynchronously] of [['rejects', false], ['throws', true]]) {
    it(`inspects the buffered chunks and logs when the stream ${label} mid-read`, async () => {
      const inspect = sinon.stub().resolves()
      const error = new Error('connection reset')

      await interceptStream(new FakeStream(chunks, error, throwSynchronously), inspect)

      sinon.assert.calledOnceWithExactly(inspect, chunks)
      sinon.assert.calledOnceWithExactly(
        log.error,
        'AIGuard: the streamed response ended after %s chunks: %s',
        chunks.length,
        error
      )
    })
  }

  it('propagates a rejection from the inspection itself', async () => {
    const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })

    await assert.rejects(
      () => interceptStream(new FakeStream(chunks), () => Promise.reject(error)),
      candidate => candidate === error
    )
  })

  it('passes a stream through untouched when it cannot be split', () => {
    const inspect = sinon.stub()
    const stream = { [Symbol.asyncIterator]: () => {} }

    assert.strictEqual(interceptStream(stream, inspect), stream)
    sinon.assert.notCalled(inspect)
  })

  it('passes a stream through untouched when tee() throws', () => {
    const inspect = sinon.stub()
    const stream = { tee () { throw new Error('already consumed') } }

    assert.strictEqual(interceptStream(stream, inspect), stream)
    sinon.assert.notCalled(inspect)
  })
})
