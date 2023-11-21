'use strict'

const { isMainThread, threadId } = require('node:worker_threads')

module.exports = {
  END_TIMESTAMP: 'end_timestamp_ns',
  THREAD_NAME: 'thread name',
  threadNamePrefix: isMainThread ? 'Main' : `Worker #${threadId}`
}
