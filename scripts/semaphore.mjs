/**
 * Bounds how many concurrent holders of a resource are allowed at once, shared across every
 * caller that holds a reference to the same instance — unlike a per-call worker-pool queue, which
 * only bounds concurrency within one invocation and lets independent concurrent callers each open
 * their own pool.
 */
class Semaphore {
  #permits
  #queue = []

  constructor (permits) {
    this.#permits = permits
  }

  acquire () {
    if (this.#permits > 0) {
      this.#permits--
      return Promise.resolve()
    }
    return new Promise(resolve => this.#queue.push(resolve))
  }

  release () {
    const next = this.#queue.shift()
    if (next) {
      next()
    } else {
      this.#permits++
    }
  }
}

export { Semaphore }
