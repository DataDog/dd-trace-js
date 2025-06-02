'use strict'
const { JSONEncoder } = require('../../encode/json-encoder')

class Writer {
  constructor (interprocessCode) {
    this._encoder = new JSONEncoder()
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
  }

  flush (onDone) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, onDone)
    }
  }

  append (payload) {
    this._encoder.encode(payload)
  }

  _sendPayload (data, onDone = () => {}) {
    // ## Jest
    // Only available when `child_process` is used for the jest worker.
    // https://github.com/facebook/jest/blob/bb39cb2c617a3334bf18daeca66bd87b7ccab28b/packages/jest-worker/README.md#experimental-worker
    // If worker_threads is used, this will not work
    // TODO: make it compatible with worker_threads

    // ## Cucumber
    // This reports to the test's main process the same way test data is reported by Cucumber
    // See cucumber code:
    // https://github.com/cucumber/cucumber-js/blob/5ce371870b677fe3d1a14915dc535688946f734c/src/runtime/parallel/run_worker.ts#L13
    if (process.send) { // it only works if process.send is available
      if (process.env.TINYPOOL_WORKER_ID) {
        // in vitest we have to trick the main process into thinking these are messages from
        // tinypool so they are not rejected
        process.send({ __tinypool_worker_message__: true, data }, () => {
          onDone()
        })
      } else {
        process.send([this._interprocessCode, data], () => {
          onDone()
        })
      }
    }
    // onDone()
  }
}

module.exports = Writer
