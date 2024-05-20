'use strict'

const { httpClientRequestStart, expressMiddlewareError } = require('../channels')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

class AbortError extends Error {
  constructor (req, res) {
    super('AbortError')
    this.name = 'AbortError'
    this.req = req
    this.res = res
  }
}

function handleUncaughtException (err) {
  if (err instanceof AbortError) {
    blockError(err)
  } else {
    throw err
  }
}

function enable () {
  httpClientRequestStart.subscribe(analyzeSsrf)
  expressMiddlewareError.subscribe(handleAbortError)

  process.on('uncaughtException', handleUncaughtException)
}

function disable () {
  httpClientRequestStart.unsubscribe(analyzeSsrf)
  expressMiddlewareError.subscribe(handleAbortError)

  process.off('uncaughtException', handleUncaughtException)
}

function analyzeSsrf (ctx) {
  // TODO - analyze SSRF
  //  currently just for testing purpose, blocking 50% of the requests that are not calling to the agent
  if (
    ctx.args.uri.includes('rasp-block') &&
    ctx.abortData
  ) {
    const store = storage.getStore()
    const req = store?.req
    const res = store?.res

    if (req) {
      ctx.abortData.abortController.abort()
      ctx.abortData.error = new AbortError(req, res)
    }
  }
}

// Prevents the execution of the default exception handler and executes custom blocking logic
function handleAbortError ({ req, error, abortController }) {
  if (error instanceof AbortError) {
    blockError(error)
    abortController?.abort()
  }
}

function blockError (error) {
  const res = error.res
  // TODO Change this for the action returned by the waf, check headersSent etc.
  if (res.headersSent) {
    log.warn('Cannot send blocking response when headers have already been sent')
    res.end()
  } else {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Blocked by AppSec')
  }
}

module.exports = { enable, disable }
