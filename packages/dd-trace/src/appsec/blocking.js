'use strict'

const log = require('../log')
const blockedTemplates = require('./blocked_templates')
const { updateBlockFailureMetric } = require('./telemetry')

const detectedSpecificEndpoints = {}

let templateHtml = blockedTemplates.html
let templateJson = blockedTemplates.json
let templateGraphqlJson = blockedTemplates.graphqlJson

let defaultBlockingActionParameters

const responseBlockedSet = new WeakSet()

const specificBlockingTypes = {
  GRAPHQL: 'graphql'
}

function getSpecificKey (method, url) {
  return `${method}+${url}`
}

function addSpecificEndpoint (method, url, type) {
  detectedSpecificEndpoints[getSpecificKey(method, url)] = type
}

function getBlockWithRedirectData (actionParameters) {
  let statusCode = actionParameters.status_code
  if (!statusCode || statusCode < 300 || statusCode >= 400) {
    statusCode = 303
  }
  const headers = {
    Location: actionParameters.location
  }

  return { headers, statusCode }
}

function getSpecificBlockingData (type) {
  switch (type) {
    case specificBlockingTypes.GRAPHQL:
      return {
        type: 'application/json',
        body: templateGraphqlJson
      }
  }
}

function getBlockWithContentData (req, specificType, actionParameters) {
  let type
  let body

  const specificBlockingType = specificType || detectedSpecificEndpoints[getSpecificKey(req.method, req.url)]
  if (specificBlockingType) {
    const specificBlockingContent = getSpecificBlockingData(specificBlockingType)
    type = specificBlockingContent?.type
    body = specificBlockingContent?.body
  }

  if (!type) {
    // parse the Accept header, ex: Accept: text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8
    const accept = req.headers.accept?.split(',').map((str) => str.split(';', 1)[0].trim())

    if (!actionParameters || actionParameters.type === 'auto') {
      if (accept?.includes('text/html') && !accept.includes('application/json')) {
        type = 'text/html; charset=utf-8'
        body = templateHtml
      } else {
        type = 'application/json'
        body = templateJson
      }
    } else {
      if (actionParameters.type === 'html') {
        type = 'text/html; charset=utf-8'
        body = templateHtml
      } else {
        type = 'application/json'
        body = templateJson
      }
    }
  }

  const statusCode = actionParameters?.status_code || 403

  const headers = {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body)
  }

  return { body, statusCode, headers }
}

function getBlockingData (req, specificType, actionParameters) {
  return actionParameters?.location
    ? getBlockWithRedirectData(actionParameters)
    : getBlockWithContentData(req, specificType, actionParameters)
}

function block (req, res, rootSpan, abortController, actionParameters = defaultBlockingActionParameters) {
  try {
    if (res.headersSent) {
      log.warn('[ASM] Cannot send blocking response when headers have already been sent')

      throw new Error('Headers have already been sent')
    }

    const { body, headers, statusCode } = getBlockingData(req, null, actionParameters)

    for (const headerName of res.getHeaderNames()) {
      res.removeHeader(headerName)
    }

    res.writeHead(statusCode, headers)

    // this is needed to call the original end method, since express-session replaces it
    res.constructor.prototype.end.call(res, body)

    rootSpan.setTag('appsec.blocked', 'true')

    responseBlockedSet.add(res)
    abortController?.abort()

    return true
  } catch (err) {
    rootSpan?.setTag('_dd.appsec.block.failed', 1)
    log.error('[ASM] Blocking error', err)

    updateBlockFailureMetric(req)
    return false
  }
}

function getBlockingAction (actions) {
  // waf only returns one action, but it prioritizes redirect over block
  return actions?.redirect_request || actions?.block_request
}

function setTemplates (config) {
  templateHtml = config.appsec.blockedTemplateHtml || blockedTemplates.html

  templateJson = config.appsec.blockedTemplateJson || blockedTemplates.json

  templateGraphqlJson = config.appsec.blockedTemplateGraphql || blockedTemplates.graphqlJson
}

function isBlocked (res) {
  return responseBlockedSet.has(res)
}

function setDefaultBlockingActionParameters (actions) {
  const blockAction = actions?.find(action => action.id === 'block')

  defaultBlockingActionParameters = blockAction?.parameters
}

module.exports = {
  addSpecificEndpoint,
  block,
  specificBlockingTypes,
  getBlockingData,
  getBlockingAction,
  setTemplates,
  isBlocked,
  setDefaultBlockingActionParameters
}
