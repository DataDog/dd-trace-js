'use strict'

const request = require('./request')
const log = require('../../log')
const { safeJSONStringify } = require('./util')
const http = require('http')

function isAgentInitialized () {
  return new Promise((resolve) => {
    http.request('http://127.0.0.1:8126/info', { method: 'GET' }, response => {
      if (response.statusCode === 200) {
        resolve(true)
      } else {
        resolve(false)
      }
    }).on('error', () => {
      resolve(false)
    }).end()
  })
}

class Writer {
  constructor ({ url }) {
    this._url = url
  }

  async flush (awaitAgentInitToFlush = false, done = () => {}) {
    const count = this._encoder.count()

    if (!request.writable) {
      this._encoder.reset()
      done()
    } else if (count > 0) {
      const payload = this._encoder.makePayload()
      try {
        if (awaitAgentInitToFlush) {
          while (!(await isAgentInitialized())) {
            log.debug('Agent is not initialized yet. Waiting to flush traces')
            await new Promise(resolve => setTimeout(resolve, 500))
          }
          log.debug('Agent is initialized. Flushing traces')
        }
        this._sendPayload(payload, count, done)
      } catch (e) {
        log.error(e)
      }
    } else {
      done()
    }
  }

  append (payload) {
    if (!request.writable) {
      log.debug(() => `Maximum number of active requests reached. Payload discarded: ${safeJSONStringify(payload)}`)
      return
    }

    log.debug(() => `Encoding payload: ${safeJSONStringify(payload)}`)

    this._encode(payload)
  }

  _encode (payload) {
    this._encoder.encode(payload)
  }

  setUrl (url) {
    this._url = url
  }
}

module.exports = Writer
