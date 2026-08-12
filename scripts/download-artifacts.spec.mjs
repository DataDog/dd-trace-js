import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, it } from 'mocha'

import { Semaphore } from './download-artifacts.mjs'

// Acquires `semaphore`, records the peak number of concurrently active holders onto `peakTracker`,
// holds briefly, then releases.
async function acquireAndTrackPeak (semaphore, peakTracker) {
  await semaphore.acquire()
  peakTracker.active++
  peakTracker.peak = Math.max(peakTracker.peak, peakTracker.active)
  await sleep(5)
  peakTracker.active--
  semaphore.release()
}

describe('download-artifacts', () => {
  describe('Semaphore', () => {
    it('never lets more than the given number of permits run at once', async () => {
      const semaphore = new Semaphore(2)
      const peakTracker = { active: 0, peak: 0 }

      await Promise.all(Array.from({ length: 5 }, () => acquireAndTrackPeak(semaphore, peakTracker)))

      assert.equal(peakTracker.peak, 2)
    })

    it('holds the cap across independent batches acquiring concurrently', async () => {
      // Regression test: All Green calls `downloadArtifacts` once per sibling workflow, and more
      // than one call can be in flight at the same time (see `all-green.mjs`'s `scheduleProcessing`).
      // A per-call limiter would let each batch open its own pool of permits; sharing one `Semaphore`
      // module-wide is what keeps the aggregate bounded instead.
      const semaphore = new Semaphore(3)
      const peakTracker = { active: 0, peak: 0 }
      const task = () => acquireAndTrackPeak(semaphore, peakTracker)

      const batchA = Promise.all(Array.from({ length: 4 }, task))
      const batchB = Promise.all(Array.from({ length: 4 }, task))
      await Promise.all([batchA, batchB])

      assert.equal(peakTracker.peak, 3)
    })

    it('runs every queued acquirer eventually', async () => {
      const semaphore = new Semaphore(1)
      const order = []

      const task = async id => {
        await semaphore.acquire()
        order.push(id)
        semaphore.release()
      }

      await Promise.all([task('a'), task('b'), task('c')])

      assert.deepEqual(order.sort(), ['a', 'b', 'c'])
    })
  })
})
