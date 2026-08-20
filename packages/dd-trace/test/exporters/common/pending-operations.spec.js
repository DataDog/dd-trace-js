'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const PendingOperations = require('../../../src/exporters/common/pending-operations')

const execFileAsync = promisify(execFile)

describe('PendingOperations', () => {
  it('returns a no-op cancellation when the boundary is already complete', () => {
    const operations = new PendingOperations()
    const done = sinon.spy()

    const cancel = operations.wait(done)
    cancel()

    sinon.assert.calledOnce(done)
  })

  it('waits for operations active at the boundary without including later operations', () => {
    const operations = new PendingOperations()
    const completeFirst = operations.start()
    const done = sinon.spy()

    operations.wait(done)
    const completeSecond = operations.start()
    completeFirst()

    sinon.assert.calledOnce(done)
    completeSecond()
  })

  it('waits for out-of-order operations to complete contiguously', () => {
    const operations = new PendingOperations()
    const completeFirst = operations.start()
    const completeSecond = operations.start()
    const done = sinon.spy()

    operations.wait(done)
    completeSecond()
    sinon.assert.notCalled(done)

    completeFirst()
    sinon.assert.calledOnce(done)
  })

  it('merges out-of-order completion ranges across active gaps', () => {
    const operations = new PendingOperations()
    const completions = []
    for (let index = 0; index < 6; index++) completions.push(operations.start())
    const done = sinon.spy()

    operations.wait(done)
    completions[1]()
    completions[2]()
    completions[5]()
    completions[4]()
    completions[3]()
    sinon.assert.notCalled(done)

    completions[0]()
    sinon.assert.calledOnce(done)
  })

  it('detaches a cancelled boundary callback', () => {
    const operations = new PendingOperations()
    const complete = operations.start()
    const done = sinon.spy()

    const cancel = operations.wait(done)
    cancel()
    complete()

    sinon.assert.notCalled(done)
  })

  it('releases cancelled boundaries behind an older live boundary', async () => {
    const fixture = path.join(__dirname, '..', '..', 'fixtures', 'pending-operations-retention.js')
    const { stdout } = await execFileAsync(process.execPath, ['--expose-gc', fixture])
    const retainedBytes = Number(stdout)

    assert.ok(retainedBytes < 8 * 1024 * 1024, `retained ${retainedBytes} bytes`)
  })

  it('compacts completed operations behind an older active operation', async () => {
    const fixture = path.join(__dirname, '..', '..', 'fixtures', 'pending-operations-retention.js')
    const { stdout } = await execFileAsync(process.execPath, ['--expose-gc', fixture, 'completions'])
    const retainedBytes = Number(stdout)

    assert.ok(retainedBytes < 8 * 1024 * 1024, `retained ${retainedBytes} bytes`)
  })

  it('completes each operation once', () => {
    const operations = new PendingOperations()
    const complete = operations.start()
    const done = sinon.spy()

    operations.wait(done)
    complete()
    complete()

    sinon.assert.calledOnce(done)
  })

  it('owns callback-style operation completion when the consumer throws', () => {
    const operations = new PendingOperations()
    const error = new Error('consumer failed')
    const done = sinon.stub().throws(error)

    assert.throws(() => operations.track(complete => complete(), done), error)
    sinon.assert.calledOnce(done)

    const boundaryDone = sinon.spy()
    operations.wait(boundaryDone)
    sinon.assert.calledOnce(boundaryDone)
  })

  it('releases sibling boundaries when one callback throws', () => {
    const operations = new PendingOperations()
    const complete = operations.start()
    const error = new Error('boundary failed')
    const siblingDone = sinon.spy()

    operations.wait(() => { throw error })
    operations.wait(siblingDone)

    assert.throws(complete, error)
    sinon.assert.calledOnce(siblingDone)
  })
})
