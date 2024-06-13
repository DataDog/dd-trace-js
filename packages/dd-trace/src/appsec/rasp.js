'use strict'

const { storage } = require('../../../datadog-core')
const addresses = require('./addresses')
const { httpClientRequestStart } = require('./channels')
const web = require('../plugins/util/web')
const waf = require('./waf')
const { getBlockingAction, block } = require('./blocking')

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

const RULE_TYPES = {
  SSRF: 'ssrf'
}

function enable () {
  httpClientRequestStart.subscribe(analyzeSsrf)

  process.on('uncaughtException', handleUncaughtException)
}

function disable () {
  if (httpClientRequestStart.hasSubscribers) httpClientRequestStart.unsubscribe(analyzeSsrf)

  process.off('uncaughtException', handleUncaughtException)
}

function analyzeSsrf (ctx) {
  const store = storage.getStore()
  const req = store?.req
  const url = ctx.args.uri

  if (!req || !url) return

  const persistent = {
    [addresses.HTTP_OUTGOING_URL]: url
  }
  // TODO: Currently this is monitoring/blocking, we should
  //     generate stack traces if SSRF attempts
  const actions = waf.run({ persistent }, req, RULE_TYPES.SSRF)

  const res = store?.res
  handleResult(actions, req, res, ctx.abortController)
}

function handleResult (actions, req, res, abortController) {
  const blockingAction = getBlockingAction(actions)
  if (blockingAction && abortController) {
    const abortError = new AbortError(req, res, blockingAction)
    abortController.abort(abortError)

    // TODO Delete this if when support for node 16 is removed
    if (!abortController.signal.reason) {
      abortController.signal.reason = abortError
    }
  }
}

module.exports = {
  enable,
  disable
}
