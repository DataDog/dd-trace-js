'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('./remote_config')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('./channels')
const waf = require('./waf')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { block, loadTemplates, loadTemplatesAsync } = require('./blocking')

let isEnabled = false
let config

function enable (_config) {
  if (isEnabled) return

  try {
    loadTemplates(_config)
    const rules = fs.readFileSync(_config.appsec.rules || path.join(__dirname, 'recommended.json'))
    enableFromRules(_config, JSON.parse(rules))
  } catch (err) {
    abortEnable(err)
  }
}

async function enableAsync (_config) {
  if (isEnabled) return

  try {
    await loadTemplatesAsync(_config)
    const rules = await fs.promises.readFile(_config.appsec.rules || path.join(__dirname, 'recommended.json'))
    enableFromRules(_config, JSON.parse(rules))
  } catch (err) {
    abortEnable(err)
  }
}

function enableFromRules (_config, rules) {
  RuleManager.applyRules(rules, _config.appsec)

  remoteConfig.enableAsmData(_config.appsec)
  remoteConfig.enableAsmDD(_config.appsec)
  remoteConfig.enableAsm(_config.appsec)

  Reporter.setRateLimit(_config.appsec.rateLimit)

  incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
  incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)

  isEnabled = true
  config = _config
}

function abortEnable (err) {
  log.error('Unable to start AppSec')
  log.error(err)

  disable()
}

function incomingHttpStartTranslator ({ req, res, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const clientIp = extractIp(config, req)

  rootSpan.addTags({
    '_dd.appsec.enabled': 1,
    '_dd.runtime_family': 'nodejs',
    [HTTP_CLIENT_IP]: clientIp
  })

  if (clientIp) {
    const actions = waf.run({
      [addresses.HTTP_CLIENT_IP]: clientIp
    }, req)

    if (!actions || !abortController) return

    if (actions.includes('block')) {
      block(req, res, rootSpan, abortController)
    }
  }
}

function incomingHttpEndTranslator ({ req, res }) {
  const requestHeaders = Object.assign({}, req.headers)
  delete requestHeaders.cookie

  // TODO: this doesn't support headers sent with res.writeHead()
  const responseHeaders = Object.assign({}, res.getHeaders())
  delete responseHeaders['set-cookie']

  const payload = {
    [addresses.HTTP_INCOMING_URL]: req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: req.method,
    [addresses.HTTP_INCOMING_RESPONSE_CODE]: res.statusCode,
    [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
  }

  // TODO: temporary express instrumentation, will use express plugin later
  if (req.body !== undefined && req.body !== null) {
    payload[addresses.HTTP_INCOMING_BODY] = req.body
  }

  if (req.query && typeof req.query === 'object') {
    payload[addresses.HTTP_INCOMING_QUERY] = req.query
  }

  if (req.params && typeof req.params === 'object') {
    payload[addresses.HTTP_INCOMING_PARAMS] = req.params
  }

  if (req.cookies && typeof req.cookies === 'object') {
    payload[addresses.HTTP_INCOMING_COOKIES] = {}

    for (const k of Object.keys(req.cookies)) {
      payload[addresses.HTTP_INCOMING_COOKIES][k] = [req.cookies[k]]
    }
  }

  waf.run(payload, req)

  waf.disposeContext(req)

  Reporter.finishRequest(req, res)
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()

  remoteConfig.disableAsmData()
  remoteConfig.disableAsmDD()
  remoteConfig.disableAsm()

  // Channel#unsubscribe() is undefined for non active channels
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
}

module.exports = {
  enable,
  enableAsync,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
