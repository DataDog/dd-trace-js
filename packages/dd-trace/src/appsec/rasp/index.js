'use strict'
// TODO list
//  - [ ] This should work only in express requests
//  - [x] DD_APPSEC_STACK_TRACE_ENABLED to enable/disable stack trace, default is true
//  - [ ] DD_APPSEC_MAX_STACK_TRACES maximum number of stack traces to be reported due to RASP events, default is 2
//  - [x] DD_APPSEC_MAX_STACK_TRACE_DEPTH defines the maximum depth of a stack trace
//        to be reported due to RASP events, default is 32
//  - [ ] Extract server.io.net.url address (probably it is already in dc channel data)
//  - [ ] Add telemetry and metrics
//  - [ ] Handle waf results
//  - [ ] Handle generate_stack action type

const crypto = require('crypto')

const { httpClientRequestStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const { generateStackTraceForMetaStruct } = require('./stack_trace')
const web = require('../../plugins/util/web')
const waf = require('../waf')
const addresses = require('../addresses')
const { getBlockingAction, block } = require('../blocking')

let config
class AbortError extends Error {
  constructor (req, res, blockingAction) {
    super('AbortError')
    this.name = 'AbortError'
    this.req = req
    this.res = res
    this.blockingAction = blockingAction
  }
}

function handleUncaughtException (err) {
  if (err instanceof AbortError) {
    const { req, res, blockingAction } = err
    block(req, res, web.root(req), null, blockingAction)
  } else {
    throw err
  }
}

function enable (_config) {
  config = _config

  httpClientRequestStart.subscribe(analyzeSsrf)

  // TODO Subscribe and unsubscribe to the uncaughtException event when it is thrown
  process.on('uncaughtException', handleUncaughtException)
}

function disable () {
  httpClientRequestStart.unsubscribe(analyzeSsrf)

  process.off('uncaughtException', handleUncaughtException)
}

function getOutgoingUrl (args) {
  if (args) {
    if (args.uri) {
      return args.uri
    }
    if (args.options) {
      if (args.options.href) {
        return args.options.href
      }
      if (args.options.protocol && args.options.hostname) {
        let url = `${args.options.protocol}//${args.options.hostname}`
        if (args.options.port) {
          url += `:${args.options.port}`
        }
        url += args.options.path || ''
        return url
      }
    }
  }
}

function analyzeSsrf (ctx) {
  const store = storage.getStore()
  const req = store?.req
  if (req) {
    const url = getOutgoingUrl(ctx.args)
    if (url) {
      const persistent = {
        [addresses.RASP_IO_URL]: url
      }

      const actions = waf.run({ persistent }, req, 'ssrf')

      const res = store?.res
      handleWafResults(actions, ctx.abortData, req, res)
    }
  }
}

function handleWafResults (actions, abortData, req, res) {
  const blockingAction = getBlockingAction(actions)
  if (blockingAction && abortData) {
    abortData.abortController.abort()
    abortData.error = new AbortError(req, res, blockingAction)
  }

  // TODO cc @CarlesDD
  if (config.appsec.stackTrace.enabled && actions?.generate_stack) {
    const frames = generateStackTraceForMetaStruct(config.appsec.stackTrace.maxDepth)
    const rootSpan = web.root(req)
    if (rootSpan) {
      let metaStruct = rootSpan.meta_struct
      if (!metaStruct) {
        metaStruct = {}
        rootSpan.meta_struct = metaStruct
      }
      let ddStack = metaStruct['_dd.stack']
      if (!ddStack) {
        metaStruct['_dd.stack'] = ddStack = {}
      }
      let exploitStacks = ddStack.exploit
      if (!exploitStacks) {
        exploitStacks = []
        ddStack.exploit = exploitStacks
      }
      if (exploitStacks.length < 2) { // TODO Check from config
        exploitStacks.push({
          id: crypto.randomBytes(8).toString('hex'), // TODO temporary id
          language: 'nodejs',
          frames
        })
      }
    }
  }
}

module.exports = { enable, disable }
