'use strict'

const log = require('../log')
const { IS_SERVERLESS } = require('../serverless')
const RuleManager = require('./rule_manager')
const appsecRemoteConfig = require('./remote_config')
const {
  bodyParser,
  cookieParser,
  multerParser,
  fastifyBodyParser,
  fastifyCookieParser,
  http2ServerRequestAdopt,
  incomingHttpRequestStart,
  incomingHttpRequestEnd,
  lambdaStartInvocation,
  lambdaEndInvocation,
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
  informationalResponse,
  routerParam,
  fastifyResponseChannel,
  fastifyPathParams,
  stripeCheckoutSessionCreate,
  stripePaymentIntentCreate,
  stripeConstructEvent,
} = require('./channels')
const Reporter = require('./reporter')
const appsecTelemetry = require('./telemetry')
const apiSecurity = require('./api_security')
const { setTemplates } = require('./blocking')
const UserTracking = require('./user_tracking')
const graphql = require('./graphql')
const lambda = require('./lambda')
const rasp = require('./rasp')
const httpRequest = require('./handlers/http-request')
const httpResponse = require('./handlers/http-response')
const httpShared = require('./handlers/http-shared')
const auth = require('./handlers/auth')
const payments = require('./handlers/payments')

let isEnabled = false

// Single source of truth for what enable() subscribes and disable() unsubscribes,
// so the two can't drift apart.
const channelHandlers = [
  [bodyParser, httpRequest.onRequestBodyParsed],
  [multerParser, httpRequest.onRequestBodyParsed],
  [cookieParser, httpRequest.onRequestCookieParser],
  [http2ServerRequestAdopt, httpShared.onHttp2ServerRequestAdopt],
  [incomingHttpRequestStart, httpRequest.incomingHttpStartTranslator],
  [incomingHttpRequestEnd, httpRequest.incomingHttpEndTranslator],
  [passportVerify, auth.onPassportVerify],
  [passportUser, auth.onPassportDeserializeUser],
  [expressSession, auth.onExpressSession],
  [queryParser, httpRequest.onRequestQueryParsed],
  [nextBodyParsed, httpRequest.onRequestBodyParsed],
  [nextQueryParsed, httpRequest.onRequestQueryParsed],
  [expressProcessParams, httpRequest.onRequestProcessParams],
  [fastifyBodyParser, httpRequest.onRequestBodyParsed],
  [fastifyQueryParams, httpRequest.onRequestQueryParsed],
  [fastifyCookieParser, httpRequest.onRequestCookieParser],
  [fastifyPathParams, httpRequest.onRequestProcessParams],
  [routerParam, httpRequest.onRequestProcessParams],
  [responseBody, httpResponse.onResponseBody],
  [fastifyResponseChannel, httpResponse.onResponseBody],
  [responseWriteHead, httpResponse.onResponseWriteHead],
  [responseSetHeader, httpResponse.onResponseOperation],
  [informationalResponse, httpResponse.onResponseOperation],
  [stripeCheckoutSessionCreate, payments.onStripeCheckoutSessionCreate],
  [stripePaymentIntentCreate, payments.onStripePaymentIntentCreate],
  [stripeConstructEvent, payments.onStripeConstructEvent],
  [lambdaStartInvocation, lambda.onLambdaStartInvocation],
  [lambdaEndInvocation, lambda.onLambdaEndInvocation],
]

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

    appsecRemoteConfig.enableWafUpdate(_config.appsec)

    Reporter.init(_config.appsec, _config.inferredProxyServicesEnabled)

    apiSecurity.configure(_config)

    UserTracking.setCollectionMode(_config.appsec.eventTracking.mode, false)

    httpRequest.setConfig(_config)

    for (const [channel, handler] of channelHandlers) {
      channel.subscribe(handler)
    }

    isEnabled = true
  } catch (err) {
    if (IS_SERVERLESS) {
      log.debug('[ASM] Serverless mode: suppressing error log, calling disable()')
    } else {
      log.error('[ASM] Unable to start AppSec', err)
    }

    disable()
  }
}

function disable () {
  isEnabled = false

  RuleManager.clearAllRules()

  appsecTelemetry.disable()
  graphql.disable()
  rasp.disable()

  appsecRemoteConfig.disableWafUpdate()

  apiSecurity.disable()

  httpRequest.setConfig(undefined)

  // Channel#unsubscribe() is undefined for non active channels
  for (const [channel, handler] of channelHandlers) {
    if (channel.hasSubscribers) channel.unsubscribe(handler)
  }
}

module.exports = {
  enable,
  disable,
  incomingHttpStartTranslator: httpRequest.incomingHttpStartTranslator,
  incomingHttpEndTranslator: httpRequest.incomingHttpEndTranslator,
}
