import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { Semaphore } from './semaphore.mjs'

describe('Semaphore', () => {
  it('grants permits up to the limit immediately, then queues the rest', async () => {
    const semaphore = new Semaphore(2)
    const resolved = [false, false, false]
    semaphore.acquire().then(() => { resolved[0] = true })
    semaphore.acquire().then(() => { resolved[1] = true })
    semaphore.acquire().then(() => { resolved[2] = true })

    // Both permit-bearing acquires resolve as microtasks; flush the queue before asserting.
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(resolved, [true, true, false])
  })

  it('hands a released permit to the next queued acquirer, in FIFO order', async () => {
    const semaphore = new Semaphore(1)
    const order = []
    const first = semaphore.acquire().then(() => order.push('first'))
    const second = semaphore.acquire().then(() => order.push('second'))

    await first
    semaphore.release()
    await second

    assert.deepEqual(order, ['first', 'second'])
  })

  it('increments its permit count on release when nothing is queued', async () => {
    const semaphore = new Semaphore(1)
    await semaphore.acquire()
    semaphore.release()

    // If release() hadn't restored the permit, this second acquire would hang forever.
    await semaphore.acquire()
  })

  it('shares its cap across acquirers regardless of which call site they came from', async () => {
    // Regression test: All Green calls `downloadArtifacts` once per sibling workflow, and more than
    // one call can be in flight at once (see `all-green.mjs`'s `scheduleProcessing`). A per-call
    // limiter would let each call open its own pool of permits instead of sharing one cap; passing
    // the same `Semaphore` instance to every caller is what keeps the aggregate bounded.
    const semaphore = new Semaphore(2)
    const resolved = [false, false, false, false]
    semaphore.acquire().then(() => { resolved[0] = true }) // batch A
    semaphore.acquire().then(() => { resolved[1] = true }) // batch A
    const batchBFirst = semaphore.acquire().then(() => { resolved[2] = true }) // batch B
    semaphore.acquire().then(() => { resolved[3] = true }) // batch B

    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(resolved, [true, true, false, false])

    semaphore.release()
    await batchBFirst
    assert.deepEqual(resolved, [true, true, true, false])
  })
})
