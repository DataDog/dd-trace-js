'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { storage } = require('../../../datadog-core')
const DataStreamsContext = require('../../src/datastreams/context')
const { DataStreamsManager } = require('../../src/datastreams/manager')
const { DsmPathwayCodec } = require('../../src/datastreams/pathway')

const writer = { flush: sinon.stub() }
const DataStreamsWriter = sinon.stub().returns(writer)
const { DataStreamsProcessor, ENTRY_PARENT_HASH } = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter },
})

const CONSUMER_EDGE_TAGS = ['direction:in', 'topic:queue', 'type:sqs']
const PRODUCER_HASH_HEX = 'e858292fd15a41e4'
const PRODUCER_HASH = Buffer.from(PRODUCER_HASH_HEX, 'hex')
const ENTRY_PARENT_HASH_HEX = ENTRY_PARENT_HASH.toString('hex')
const PRODUCER_EDGE_TAGS = ['direction:out', 'topic:queue', 'type:kafka']
const config = {
  dsmEnabled: true,
  env: 'test',
  hostname: '127.0.0.1',
  port: 8126,
  service: 'service1',
  tags: {},
  url: new URL('http://127.0.0.1:8126'),
  version: 'v1',
}

describe('DataStreamsManager', () => {
  let manager
  let recordCheckpoint

  beforeEach(() => {
    const processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)
    recordCheckpoint = sinon.stub(processor, 'recordCheckpoint')
    manager = new DataStreamsManager(processor)
  })

  /**
   * @param {Array<Record<string, string>|undefined>} carriers Consumed in order, the way a batch
   *   consumer hands its messages over.
   */
  function parentHashesForBatch (carriers) {
    return storage('legacy').run({}, () => {
      for (const carrier of carriers) {
        manager.decodeDataStreamsContext(carrier)
        manager.setCheckpoint(CONSUMER_EDGE_TAGS, null, 10)
      }
      return recordCheckpoint.getCalls().map(call => call.args[0].parentHash.toString('hex'))
    })
  }

  function producerCarrier () {
    return DsmPathwayCodec.encode({ hash: PRODUCER_HASH, pathwayStartNs: 1e6, edgeStartNs: 1e6 })
  }

  // Async on purpose: `.mocharc.js` sets `allowUncaught`, under which mocha rethrows a synchronous
  // failure out of its own runner and the process can exit 0 without reporting it. A rejected
  // promise goes through mocha's reporting instead, so these fail visibly.
  it('parents the checkpoint on the context the message carried', async () => {
    assert.deepStrictEqual(parentHashesForBatch([producerCarrier()]), [PRODUCER_HASH_HEX])
  })

  it('starts a new pathway for a message that carries a carrier without a pathway', async () => {
    assert.deepStrictEqual(
      parentHashesForBatch([producerCarrier(), { 'x-datadog-trace-id': '1' }]),
      [PRODUCER_HASH_HEX, ENTRY_PARENT_HASH_HEX]
    )
  })
  it('starts a new pathway for a message that carries no carrier at all', async () => {
    assert.deepStrictEqual(
      parentHashesForBatch([producerCarrier(), undefined]),
      [PRODUCER_HASH_HEX, ENTRY_PARENT_HASH_HEX]
    )
  })

  describe('_decodeAndSetCheckpoint', () => {
    let clock

    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 5, toFake: ['Date'] })
    })

    afterEach(() => {
      clock.restore()
    })

    const previousCtx = { hash: Buffer.from('0102030405060708', 'hex'), pathwayStartNs: 1e6, edgeStartNs: 2e6 }

    /**
     * @param {() => object|undefined} consume
     * @returns {{ ctx: object|undefined, store: object, checkpoints: object[] }}
     */
    function runInFreshStore (consume) {
      recordCheckpoint.resetHistory()
      return storage('legacy').run({ other: 1, dataStreamsContext: previousCtx }, () => {
        const ctx = consume()
        return {
          ctx,
          store: storage('legacy').getStore(),
          checkpoints: recordCheckpoint.getCalls().map(call => call.args[0]),
        }
      })
    }

    const carriers = {
      'a producer carrier': producerCarrier,
      'a carrier without a pathway': () => ({ 'x-datadog-trace-id': '1' }),
      'no carrier': () => undefined,
    }

    for (const [name, makeCarrier] of Object.entries(carriers)) {
      it(`leaves the store as decode then checkpoint does for ${name}`, async () => {
        const separate = runInFreshStore(() => {
          manager.decodeDataStreamsContext(makeCarrier())
          return manager.setCheckpoint([...CONSUMER_EDGE_TAGS], null, 10)
        })
        const enteredOnce = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
        let combined
        try {
          combined = runInFreshStore(() => {
            return manager._decodeAndSetCheckpoint(makeCarrier(), [...CONSUMER_EDGE_TAGS], null, 10)
          })
        } finally {
          enteredOnce.restore()
        }

        sinon.assert.calledOnce(enteredOnce)
        assert.deepStrictEqual(combined.checkpoints, separate.checkpoints)
        assert.deepStrictEqual(combined.ctx, separate.ctx)
        assert.deepStrictEqual(combined.store, separate.store)
        assert.strictEqual(combined.store.dataStreamsContext, combined.ctx)
        assert.strictEqual(combined.store.other, 1)
      })
    }

    it('leaves the decoded context in the store when the checkpoint throws', async () => {
      const error = new Error('checkpoint failed')
      manager._dataStreamsProcessor.setCheckpoint = sinon.stub().throws(error)
      const carrier = producerCarrier()
      const decoded = DsmPathwayCodec.decode(carrier)

      storage('legacy').run({ other: 1, dataStreamsContext: previousCtx }, () => {
        assert.throws(() => manager._decodeAndSetCheckpoint(carrier, [...CONSUMER_EDGE_TAGS], null, 10), error)
        assert.deepStrictEqual(storage('legacy').getStore(), { other: 1, dataStreamsContext: decoded })
      })
    })

    it('leaves the store untouched when the decode throws', async () => {
      const error = new Error('decode failed')
      const decode = sinon.stub(DsmPathwayCodec, 'decode').throws(error)
      try {
        storage('legacy').run({ other: 1, dataStreamsContext: previousCtx }, () => {
          const store = storage('legacy').getStore()
          assert.throws(() => manager._decodeAndSetCheckpoint({}, [...CONSUMER_EDGE_TAGS], null, 10), error)
          assert.strictEqual(storage('legacy').getStore(), store)
        })
      } finally {
        decode.restore()
      }
    })
  })

  describe('_startCheckpointRun', () => {
    let clock

    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 5, toFake: ['Date'] })
    })

    afterEach(() => {
      clock.restore()
    })

    const startingStores = {
      'an empty store': () => ({ other: 1 }),
      'a store holding a consumer context': () => ({
        other: 1,
        dataStreamsContext: {
          hash: PRODUCER_HASH,
          pathwayStartNs: 1e6,
          edgeStartNs: 2e6,
          previousDirection: 'direction:in',
          closestOppositeDirectionHash: ENTRY_PARENT_HASH,
          closestOppositeDirectionEdgeStart: 1e6,
        },
      }),
    }

    function plainCheckpoints (store) {
      recordCheckpoint.resetHistory()
      return storage('legacy').run(store, () => {
        const ctxs = []
        for (let i = 0; i < 3; i++) ctxs.push(manager.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10 + i))
        return {
          ctxs,
          final: DataStreamsContext.getDataStreamsContext(),
          checkpoints: recordCheckpoint.getCalls().map(call => call.args[0]),
        }
      })
    }

    for (const [name, makeStore] of Object.entries(startingStores)) {
      it(`records the same checkpoints as one setCheckpoint each, entering the store once, from ${name}`, async () => {
        const plain = plainCheckpoints(makeStore())
        recordCheckpoint.resetHistory()
        const entered = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
        let run
        try {
          run = storage('legacy').run(makeStore(), () => {
            const checkpointRun = manager._startCheckpointRun()
            const ctxs = []
            try {
              for (let i = 0; i < 3; i++) ctxs.push(checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10 + i))
            } finally {
              checkpointRun.end()
            }
            return {
              ctxs,
              final: DataStreamsContext.getDataStreamsContext(),
              checkpoints: recordCheckpoint.getCalls().map(call => call.args[0]),
              other: storage('legacy').getStore().other,
            }
          })
        } finally {
          entered.restore()
        }

        sinon.assert.calledOnce(entered)
        assert.deepStrictEqual(run.checkpoints, plain.checkpoints)
        assert.deepStrictEqual(run.ctxs, plain.ctxs)
        assert.strictEqual(run.final, run.ctxs[2])
        assert.deepStrictEqual(run.final, plain.final)
        assert.strictEqual(run.other, 1)
      })
    }

    it('does not enter the store when no checkpoint ran', async () => {
      storage('legacy').run({ other: 1 }, () => {
        const store = storage('legacy').getStore()
        manager._startCheckpointRun().end()
        assert.strictEqual(storage('legacy').getStore(), store)
      })
    })

    it('leaves the store at the last successful checkpoint when a later one throws', async () => {
      const error = new Error('checkpoint failed')
      const setCheckpoint = sinon.stub(manager._dataStreamsProcessor, 'setCheckpoint')
      setCheckpoint.callThrough()
      setCheckpoint.onSecondCall().throws(error)

      storage('legacy').run({ other: 1 }, () => {
        const checkpointRun = manager._startCheckpointRun()
        let first
        assert.throws(() => {
          try {
            first = checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10)
            checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10)
          } finally {
            checkpointRun.end()
          }
        }, error)
        assert.strictEqual(DataStreamsContext.getDataStreamsContext(), first)
      })
    })

    it('leaves the store object unchanged when the first checkpoint throws', async () => {
      const error = new Error('checkpoint failed')
      sinon.stub(manager._dataStreamsProcessor, 'setCheckpoint').throws(error)

      storage('legacy').run({ other: 1 }, () => {
        const store = storage('legacy').getStore()
        const checkpointRun = manager._startCheckpointRun()
        assert.throws(() => {
          try {
            checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10)
          } finally {
            checkpointRun.end()
          }
        }, error)
        assert.strictEqual(storage('legacy').getStore(), store)
      })
    })

    it('leaves the context undefined when the processor is disabled', async () => {
      const processor = new DataStreamsProcessor({ ...config, dsmEnabled: false })
      clearTimeout(processor.timer)
      const disabledManager = new DataStreamsManager(processor)

      storage('legacy').run({ other: 1 }, () => {
        const checkpointRun = disabledManager._startCheckpointRun()
        try {
          assert.strictEqual(checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10), undefined)
          assert.strictEqual(checkpointRun.setCheckpoint([...PRODUCER_EDGE_TAGS], null, 10), undefined)
        } finally {
          checkpointRun.end()
        }
        assert.strictEqual(DataStreamsContext.getDataStreamsContext(), null)
      })
    })
  })
})
