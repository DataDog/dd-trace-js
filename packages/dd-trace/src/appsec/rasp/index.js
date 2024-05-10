'use strict'

const { httpClientRequestStart, expressMiddlewareError } = require('../channels')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

class AbortError extends Error {
  constructor (req) {
    super('Abort error')
    this.name = 'AbortError'
    this.req = req
  }
}

function enable () {
  httpClientRequestStart.subscribe(analyzeSsrf)
  expressMiddlewareError.subscribe(handleAbortError)

  process.on('uncaughtException', (err) => {
    if (err instanceof AbortError) {
      // TODO - handle abort error
    } else {
      throw err
    }
  })
}

function disable () {
  httpClientRequestStart.unsubscribe(analyzeSsrf)
  expressMiddlewareError.subscribe(handleAbortError)
}

function analyzeSsrf (ctx) {
  // TODO - analyze SSRF
  //  currently just for testing purpose, blocking 50% of the requests that are not calling to the agent
  if (!ctx.args.uri.includes(':8126') && Math.random() >= 0.5 && ctx.abortData) {
    const store = storage.getStore()
    const req = store?.req

    if (req) {
      ctx.abortData.abortController.abort()
      ctx.abortData.error = new AbortError(req)
    }
  }
}

// Prevents the execution of the default exception handler and executes custom blocking logic
function handleAbortError ({ req, error, abortController }) {
  if (error instanceof AbortError) {
    const store = storage.getStore()
    const res = store?.res
    // TODO Change this for the action returned by the waf, check headersSent etc.
    if (res.headersSent) {
      log.warn('Cannot send blocking response when headers have already been sent')
      res.end()
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Blocked by AppSec')
    }

    abortController?.abort()
  }
}

module.exports = { enable, disable }
