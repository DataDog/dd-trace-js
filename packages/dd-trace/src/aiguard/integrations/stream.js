'use strict'

const log = require('../../log')

/**
 * Splits an SDK stream, consumes one branch, and returns the other after inspection.
 *
 * @param {object} stream
 * @param {(chunks: Array<object>) => void|Promise<void>} inspect
 * @returns {object|Promise<object>}
 */
function interceptStream (stream, inspect) {
  if (typeof stream?.tee !== 'function') return stream

  try {
    const [inspectionStream, resultStream] = stream.tee()
    return drainStream(inspectionStream).then(chunks => {
      return Promise.resolve(inspect(chunks)).then(() => resultStream)
    })
  } catch {
    return stream
  }
}

/**
 * Buffers the whole stream. A stream that ends early still yields what it delivered: truncated
 * output can carry the very violation the evaluation is looking for, so it is judged rather than
 * skipped, and the read failure is logged because nothing downstream reports it.
 *
 * @param {object} stream
 * @returns {Promise<Array<object>>}
 */
function drainStream (stream) {
  const chunks = []
  const iterator = stream[Symbol.asyncIterator]()

  function onReadError (error) {
    log.error('AIGuard: the streamed response ended after %s chunks: %s', chunks.length, error)
    return chunks
  }

  function readAll () {
    let next
    try {
      next = iterator.next()
    } catch (error) {
      return Promise.resolve(onReadError(error))
    }

    return next.then(({ done, value }) => {
      if (done) return chunks
      chunks.push(value)
      return readAll()
    }, onReadError)
  }

  return readAll()
}

module.exports = { interceptStream }
