'use strict'

/**
 * Splits an SDK stream, consumes one branch, and returns the other after inspection.
 *
 * @param {object} stream
 * @param {(chunks: Array<object>) => void|Promise<void>} inspect
 * @returns {object|Promise<object>}
 */
function interceptStream (stream, inspect) {
  if (typeof stream?.tee !== 'function') return stream

  let branches
  try {
    branches = stream.tee()
  } catch {
    return stream
  }

  const [inspectionStream, resultStream] = branches
  return drainStream(inspectionStream).then(chunks => {
    return Promise.resolve(inspect(chunks)).then(() => resultStream)
  }, () => resultStream)
}

/**
 * @param {object} stream
 * @returns {Promise<Array<object>>}
 */
function drainStream (stream) {
  const chunks = []
  const iterator = stream[Symbol.asyncIterator]()

  function readAll () {
    return iterator.next().then(({ done, value }) => {
      if (done) return chunks
      chunks.push(value)
      return readAll()
    })
  }

  return readAll()
}

module.exports = { interceptStream }
