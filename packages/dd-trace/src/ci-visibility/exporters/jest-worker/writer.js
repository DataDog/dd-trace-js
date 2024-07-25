'use strict'
const { JSONEncoder } = require('../../encode/json-encoder')

class Writer {
  constructor (interprocessCode) {
    this._encoder = new JSONEncoder()
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
  }

  flush () {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload)
    }
  }

  append (payload) {
    this._encoder.encode(payload)
  }

  _sendPayload (data) {
    // Only available when `child_process` is used for the jest worker.
    // eslint-disable-next-line
    // https://github.com/facebook/jest/blob/bb39cb2c617a3334bf18daeca66bd87b7ccab28b/packages/jest-worker/README.md#experimental-worker
    // If worker_threads is used, this will not work
    // TODO: make it compatible with worker_threads
    if (process.send) { // it only works if process.send is available
      process.send([this._interprocessCode, data])
    }
  }
}

module.exports = Writer
