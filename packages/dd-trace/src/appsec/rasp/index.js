'use strict'
// TODO list
//  - [ ] This should work only in express requests
//  - [ ] DD_APPSEC_STACK_TRACE_ENABLED to enable/disable stack trace, default is true
//  - [ ] DD_APPSEC_MAX_STACK_TRACE_DEPTH defines the maximum depth of a stack trace
//        to be reported due to RASP events, default is 32
//  - [ ] DD_APPSEC_MAX_STACK_TRACES maximum number of stack traces to be reported due to RASP events, default is 2
//  - [ ] Add ASM_RASP_SSRF RC capability
//  - [ ] Extract server.io.net.url address (probably it is already in dc channel data)
//  - [ ] Add telemetry and metrics

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

  // TODO Subscribe and unsubscribe to the uncaughtException event when it is thrown
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
