'use strict'

/**
 * Run an async worker over every item with at most `concurrency` workers in flight. Used to bound the number of open
 * file handles while generating workspace folders and patching peer dependencies (an unbounded `Promise.all` over the
 * whole `versions/` tree exhausts file descriptors / `EMFILE`). Results preserve input order; the first worker error
 * rejects the returned promise.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency Maximum number of workers running at once; must be >= 1.
 * @param {(item: T, index: number) => Promise<R> | R} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency (items, concurrency, worker) {
  if (concurrency < 1) throw new RangeError(`concurrency must be >= 1, got ${concurrency}`)

  const results = new Array(items.length)
  let nextIndex = 0

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      // Sequential within a worker is intended: concurrency comes from running several workers in parallel.
      // eslint-disable-next-line no-await-in-loop
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker))

  return results
}

module.exports = mapWithConcurrency
