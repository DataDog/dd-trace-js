'use strict'

process.env.DD_DATA_STREAMS_ENABLED = 'true'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const redis = { host: '127.0.0.1', port: 6379 }

createIntegrationTestSuite('bull', 'bull', {
  category: 'messaging',
}, (meta) => {
  const queues = []
  let setCheckpoint

  const createQueue = async (suffix) => {
    const Queue = meta.mod
    const queue = new Queue(`dsm-${suffix}-${Date.now()}`, { redis })
    queues.push(queue)
    await queue.isReady()
    return queue
  }

  const checkpoints = (direction, topic) => setCheckpoint.getCalls().filter(call =>
    call.args[0].includes(`direction:${direction}`) && call.args[0].includes(`topic:${topic}`)
  )

  beforeEach(() => {
    require('../../dd-trace').use('bull', { dsmEnabled: true })
    setCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')
  })

  afterEach(async () => {
    setCheckpoint.restore()
    await Promise.all(queues.splice(0).map(queue => queue.close()))
  })

  it('sets a produce checkpoint with bull edge tags on Queue#add', async () => {
    const queue = await createQueue('add')
    await queue.add({ message: 'hello' })

    const [produce] = checkpoints('out', queue.name)
    assert.ok(produce, 'produce checkpoint not found')
    assert.deepEqual([...produce.args[0]].sort(), ['direction:out', `topic:${queue.name}`, 'type:bull'])
    assert.ok(produce.args[3] > 0, 'expected a payload size')
  })

  it('sets one produce checkpoint per job on Queue#addBulk', async () => {
    const queue = await createQueue('bulk')
    await queue.addBulk([{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }])

    assert.equal(checkpoints('out', queue.name).length, 3)
  })

  it('sets a consume checkpoint whose parent is the produce checkpoint', async () => {
    const queue = await createQueue('consume')
    queue.process(async () => {})
    const job = await queue.add({ message: 'hello' })
    await job.finished()

    const [produce] = checkpoints('out', queue.name)
    const [consume] = checkpoints('in', queue.name)
    assert.ok(consume, 'consume checkpoint not found')
    assert.deepEqual([...consume.args[0]].sort(), ['direction:in', `topic:${queue.name}`, 'type:bull'])
    assert.deepEqual(consume.args[2].hash, produce.returnValue.hash)
  })

  it('chains the pathway through a job that produces to another queue', async () => {
    const source = await createQueue('source')
    const target = await createQueue('target')
    source.process(async job => {
      await target.add(job.data)
      await target.add(job.data)
    })
    target.process(async () => {})

    const job = await source.add({ message: 'hello' })
    await job.finished()
    await new Promise(resolve => {
      const check = () => checkpoints('in', target.name).length === 2 ? resolve() : setTimeout(check, 20)
      check()
    })

    const [consumeSource] = checkpoints('in', source.name)
    const forwards = checkpoints('out', target.name)
    assert.equal(forwards.length, 2)
    for (const forward of forwards) {
      assert.deepEqual(forward.args[2].hash, consumeSource.returnValue.hash)
    }
    for (const consumeTarget of checkpoints('in', target.name)) {
      assert.deepEqual(consumeTarget.args[2].hash, forwards[0].returnValue.hash)
    }
  })

  it('starts a new pathway for a job that carries no DSM context', async () => {
    const queue = await createQueue('no-context')
    await queue.add({ message: 'hello' })
    const job = await queue.add({ message: 'plain' })
    await queue.client.hset(queue.toKey(job.id), 'opts', JSON.stringify({ attempts: 1, delay: 0 }))

    queue.process(async () => {})
    await job.finished()

    const consumes = checkpoints('in', queue.name)
    const plain = consumes.find(call => call.args[2] === null || call.args[2] === undefined)
    assert.ok(plain, 'expected a consume checkpoint without a parent context')
  })
})
