'use strict'

const log = require('../log')
const RuleManager = require('./rule_manager')
const remoteConfig = require('../remote_config')
const {
  bodyParser,
  cookieParser,
  multerParser,
  fastifyBodyParser,
  incomingHttpRequestStart,
  incomingHttpRequestEnd,
  passportVerify,
  passportUser,
  expressSession,
  queryParser,
  nextBodyParsed,
  nextQueryParsed,
  expressProcessParams,
  fastifyQueryParams,
  responseBody,
  responseWriteHead,
  responseSetHeader,
  routerParam,
  fastifyResponseChannel,
  fastifyPathParams
} = require('./channels')
const waf = require('./waf')
const addresses = require('./addresses')
const Reporter = require('./reporter')
const appsecTelemetry = require('./telemetry')
const apiSecuritySampler = require('./api_security_sampler')
const web = require('../plugins/util/web')
const { extractIp } = require('../plugins/util/ip_extractor')
const { HTTP_CLIENT_IP } = require('../../../../ext/tags')
const { isBlocked, block, setTemplates, getBlockingAction } = require('./blocking')
const UserTracking = require('./user_tracking')
const { storage } = require('../../../datadog-core')
const graphql = require('./graphql')
const rasp = require('./rasp')
const { isInServerlessEnvironment } = require('../serverless')

const responseAnalyzedSet = new WeakSet()
const storedResponseHeaders = new WeakMap()

let isEnabled = false
let config

function enable (_config) {
  if (isEnabled) return

  try {
    appsecTelemetry.enable(_config)
    graphql.enable()

    if (_config.appsec.rasp.enabled) {
      rasp.enable(_config)
    }

    setTemplates(_config)

    RuleManager.loadRules(_config.appsec)

    remoteConfig.enableWafUpdate(_config.appsec)

    Reporter.init(_config.appsec)

    apiSecuritySampler.configure(_config)

    UserTracking.setCollectionMode(_config.appsec.eventTracking.mode, false)

    bodyParser.subscribe(onRequestBodyParsed)
    multerParser.subscribe(onRequestBodyParsed)
    cookieParser.subscribe(onRequestCookieParser)
    incomingHttpRequestStart.subscribe(incomingHttpStartTranslator)
    incomingHttpRequestEnd.subscribe(incomingHttpEndTranslator)
    passportVerify.subscribe(onPassportVerify) // possible optimization: only subscribe if collection mode is enabled
    passportUser.subscribe(onPassportDeserializeUser)
    expressSession.subscribe(onExpressSession)
    queryParser.subscribe(onRequestQueryParsed)
    nextBodyParsed.subscribe(onRequestBodyParsed)
    nextQueryParsed.subscribe(onRequestQueryParsed)
    expressProcessParams.subscribe(onRequestProcessParams)
    fastifyBodyParser.subscribe(onRequestBodyParsed)
    fastifyQueryParams.subscribe(onRequestQueryParsed)
    fastifyPathParams.subscribe(onRequestProcessParams)
    routerParam.subscribe(onRequestProcessParams)
    responseBody.subscribe(onResponseBody)
    fastifyResponseChannel.subscribe(onResponseBody)
    responseWriteHead.subscribe(onResponseWriteHead)
    responseSetHeader.subscribe(onResponseSetHeader)

    isEnabled = true
    config = _config
  } catch (err) {
    if (!isInServerlessEnvironment()) {
      log.error('[ASM] Unable to start AppSec', err)
    }

    disable()
  }
}

function onRequestBodyParsed ({ req, res, body, abortController }) {
  if (body === undefined || body === null) return

  if (!req) {
    const store = storage('legacy').getStore()
    req = store?.req
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_BODY]: body
    }
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onRequestCookieParser ({ req, res, abortController, cookies }) {
  if (!cookies || typeof cookies !== 'object') return

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_COOKIES]: cookies
    }
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
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

  const requestHeaders = { ...req.headers }
  delete requestHeaders.cookie

  const persistent = {
    [addresses.HTTP_INCOMING_URL]: req.url,
    [addresses.HTTP_INCOMING_HEADERS]: requestHeaders,
    [addresses.HTTP_INCOMING_METHOD]: req.method
  }

  if (clientIp) {
    persistent[addresses.HTTP_CLIENT_IP] = clientIp
  }

  const results = waf.run({ persistent }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function incomingHttpEndTranslator ({ req, res }) {
  const persistent = {}

  // we need to keep this to support other body parsers
  // TODO: no need to analyze it if it was already done by the body-parser hook
  if (req.body !== undefined && req.body !== null) {
    persistent[addresses.HTTP_INCOMING_BODY] = req.body
  }

  // we need to keep this to support other cookie parsers
  if (req.cookies !== null && typeof req.cookies === 'object') {
    persistent[addresses.HTTP_INCOMING_COOKIES] = req.cookies
  }

  // we need to keep this to support nextjs
  const query = req.query
  if (query !== null && typeof query === 'object') {
    persistent[addresses.HTTP_INCOMING_QUERY] = query
  }

  if (apiSecuritySampler.sampleRequest(req, res, true)) {
    persistent[addresses.WAF_CONTEXT_PROCESSOR] = { 'extract-schema': true }
  }

  if (Object.keys(persistent).length) {
    waf.run({ persistent }, req)
  }

  waf.disposeContext(req)

  const storedHeaders = storedResponseHeaders.get(req) || {}

  Reporter.finishRequest(req, res, storedHeaders)

  if (storedHeaders) {
    storedResponseHeaders.delete(req)
  }
}

function onPassportVerify ({ framework, login, user, success, abortController }) {
  const store = storage('legacy').getStore()
  const rootSpan = store?.req && web.root(store.req)

  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onPassportVerify')
    return
  }

  const results = UserTracking.trackLogin(framework, login, user, success, rootSpan)

  handleResults(results?.actions, store.req, store.req.res, rootSpan, abortController)
}

function onPassportDeserializeUser ({ user, abortController }) {
  const store = storage('legacy').getStore()
  const rootSpan = store?.req && web.root(store.req)

  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onPassportDeserializeUser')
    return
  }

  const results = UserTracking.trackUser(user, rootSpan)

  handleResults(results?.actions, store.req, store.req.res, rootSpan, abortController)
}

function onExpressSession ({ req, res, sessionId, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onExpressSession')
    return
  }

  const isSdkCalled = rootSpan.context()._tags['usr.session_id']
  if (isSdkCalled) return

  const results = waf.run({
    persistent: {
      [addresses.USER_SESSION_ID]: sessionId
    }
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onRequestQueryParsed ({ req, res, query, abortController }) {
  if (!query || typeof query !== 'object') return

  if (!req) {
    const store = storage('legacy').getStore()
    req = store?.req
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_QUERY]: query
    }
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onRequestProcessParams ({ req, res, abortController, params }) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (!params || typeof params !== 'object' || !Object.keys(params).length) return

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_PARAMS]: params
    }
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onResponseBody ({ req, res, body }) {
  if (!body || typeof body !== 'object') return
  if (!apiSecuritySampler.sampleRequest(req, res)) return

  // we don't support blocking at this point, so no results needed
  waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_BODY]: body
    }
  }, req)
}

function onResponseWriteHead ({ req, res, abortController, statusCode, responseHeaders }) {
  if (Object.keys(responseHeaders).length) {
    storedResponseHeaders.set(req, responseHeaders)
  }

  // avoid "write after end" error
  if (isBlocked(res)) {
    abortController?.abort()
    return
  }

  // avoid double waf call
  if (responseAnalyzedSet.has(res)) {
    return
  }

  const rootSpan = web.root(req)
  if (!rootSpan) return

  responseHeaders = { ...responseHeaders }
  delete responseHeaders['set-cookie']

  const results = waf.run({
    persistent: {
      [addresses.HTTP_INCOMING_RESPONSE_CODE]: String(statusCode),
      [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: responseHeaders
    }
  }, req)

  responseAnalyzedSet.add(res)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

function onResponseSetHeader ({ res, abortController }) {
  if (isBlocked(res)) {
    abortController?.abort()
  }
}

function handleResults (actions, req, res, rootSpan, abortController) {
  if (!actions || !req || !res || !rootSpan || !abortController) return

  const blockingAction = getBlockingAction(actions)
  if (blockingAction) {
    block(req, res, rootSpan, abortController, blockingAction)
  }
}

function disable () {
  isEnabled = false
  config = null

  RuleManager.clearAllRules()

  appsecTelemetry.disable()
  graphql.disable()
  rasp.disable()

  remoteConfig.disableWafUpdate()

  apiSecuritySampler.disable()

  // Channel#unsubscribe() is undefined for non active channels
  if (bodyParser.hasSubscribers) bodyParser.unsubscribe(onRequestBodyParsed)
  if (multerParser.hasSubscribers) multerParser.unsubscribe(onRequestBodyParsed)
  if (cookieParser.hasSubscribers) cookieParser.unsubscribe(onRequestCookieParser)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(incomingHttpStartTranslator)
  if (incomingHttpRequestEnd.hasSubscribers) incomingHttpRequestEnd.unsubscribe(incomingHttpEndTranslator)
  if (passportVerify.hasSubscribers) passportVerify.unsubscribe(onPassportVerify)
  if (passportUser.hasSubscribers) passportUser.unsubscribe(onPassportDeserializeUser)
  if (expressSession.hasSubscribers) expressSession.unsubscribe(onExpressSession)
  if (queryParser.hasSubscribers) queryParser.unsubscribe(onRequestQueryParsed)
  if (nextBodyParsed.hasSubscribers) nextBodyParsed.unsubscribe(onRequestBodyParsed)
  if (nextQueryParsed.hasSubscribers) nextQueryParsed.unsubscribe(onRequestQueryParsed)
  if (expressProcessParams.hasSubscribers) expressProcessParams.unsubscribe(onRequestProcessParams)
  if (fastifyBodyParser.hasSubscribers) fastifyBodyParser.unsubscribe(onRequestBodyParsed)
  if (fastifyQueryParams.hasSubscribers) fastifyQueryParams.unsubscribe(onRequestQueryParsed)
  if (fastifyPathParams.hasSubscribers) fastifyPathParams.unsubscribe(onRequestProcessParams)
  if (routerParam.hasSubscribers) routerParam.unsubscribe(onRequestProcessParams)
  if (responseBody.hasSubscribers) responseBody.unsubscribe(onResponseBody)
  if (fastifyResponseChannel.hasSubscribers) fastifyResponseChannel.unsubscribe(onResponseBody)
  if (responseWriteHead.hasSubscribers) responseWriteHead.unsubscribe(onResponseWriteHead)
  if (responseSetHeader.hasSubscribers) responseSetHeader.unsubscribe(onResponseSetHeader)
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator,
  incomingHttpEndTranslator
}
