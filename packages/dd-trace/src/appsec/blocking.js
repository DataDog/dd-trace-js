'use strict'

const { LRUCache } = require('../../../../vendor/dist/lru-cache')
const log = require('../log')
const web = require('../plugins/util/web')
const blockedTemplates = require('./blocked_templates')
const { updateBlockFailureMetric } = require('./telemetry')

// Bounded by the LRU as defense-in-depth: getSpecificKey already keys on the
// resolved route (or the path with the query string stripped) so cardinality
// follows the routing table, not the URL space.
const SPECIFIC_ENDPOINT_CACHE_MAX = 16_384
const detectedSpecificEndpoints = new LRUCache({ max: SPECIFIC_ENDPOINT_CACHE_MAX })

const templateKeyword = '[security_response_id]'

const templates = {
  html: {
    body: null,
    idIndex: -1,
    type: 'text/html; charset=utf-8',
  },
  json: {
    body: null,
    idIndex: -1,
    type: 'application/json',
  },
  graphqlJson: {
    body: null,
    idIndex: -1,
    type: 'application/json',
  },
}

setTemplates()

let defaultBlockingActionParameters

const responseBlockedSet = new WeakSet()

const blockDelegations = new WeakMap()

const specificBlockingTypes = {
  GRAPHQL: 'graphqlJson',
}

function getSpecificKey (req) {
  const route = web.getContext(req)?.paths?.join('')
  if (route) return `${req.method}+${route}`

  // Strip the query string so unique parameters do not balloon the cache.
  const url = req.originalUrl || req.url || ''
  const queryStart = url.indexOf('?')
  return `${req.method}+${queryStart === -1 ? url : url.slice(0, queryStart)}`
}

function addSpecificEndpoint (req, type) {
  detectedSpecificEndpoints.set(getSpecificKey(req), type)
}

function getBlockWithRedirectData (actionParameters) {
  let statusCode = actionParameters.status_code
  if (!statusCode || statusCode < 300 || statusCode >= 400) {
    statusCode = 303
  }

  const headers = { Location: actionParameters.location }

  if (headers.Location) {
    headers.Location = headers.Location.replace(templateKeyword, actionParameters.security_response_id ?? '')
  }

  return { headers, statusCode }
}

function getBlockWithContentData (req, specificType, actionParameters) {
  let type
  let body

  const specificBlockingType = specificType || detectedSpecificEndpoints.get(getSpecificKey(req))
  if (specificBlockingType) {
    const specificBlockingContent = getTemplate(specificBlockingType, actionParameters)
    type = specificBlockingContent?.type
    body = specificBlockingContent?.body
  }

  if (!type) {
    // parse the Accept header, ex: Accept: text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8
    const accept = req.headers.accept?.split(',').map((str) => str.split(';', 1)[0].trim())

    let templateName = 'json'

    if (!actionParameters || actionParameters.type === 'auto') {
      if (accept?.includes('text/html') && !accept.includes('application/json')) {
        templateName = 'html'
      }
    } else if (actionParameters.type === 'html') {
      templateName = 'html'
    }

    ({ type, body } = getTemplate(templateName, actionParameters))
  }

  const statusCode = actionParameters?.status_code || 403

  const headers = {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  }

  return { body, statusCode, headers }
}

function getBlockingData (req, specificType, actionParameters) {
  return actionParameters?.location
    ? getBlockWithRedirectData(actionParameters)
    : getBlockWithContentData(req, specificType, actionParameters)
}

function block (req, res, rootSpan, abortController, actionParameters = defaultBlockingActionParameters) {
  // synchronous blocking overrides previously created delegations
  blockDelegations.delete(res)

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

    // TODO: if blocking fails, then the response will never be sent ?

    updateBlockFailureMetric(req)
    return false
  }
}

function registerBlockDelegation (req, res) {
  const args = arguments

  return new Promise((resolve) => {
    // ignore subsequent delegations by never calling their resolve()
    if (blockDelegations.has(res)) return

    blockDelegations.set(res, { args, resolve })
  })
}

function callBlockDelegation (res) {
  const delegation = blockDelegations.get(res)
  if (delegation) {
    const result = block.apply(this, delegation.args)
    delegation.resolve(result)
    return result
  }
}

function getBlockingAction (actions) {
  // waf only returns one action, but it prioritizes redirect over block
  return actions?.redirect_request || actions?.block_request
}

/**
 * @param {import('../config/config-base')} [config] - Tracer configuration
 */
function setTemplates (config) {
  templates.html.body = config?.appsec?.blockedTemplateHtml
  templates.json.body = config?.appsec?.blockedTemplateJson
  templates.graphqlJson.body = config?.appsec?.blockedTemplateGraphql

  for (const type of Object.keys(templates)) {
    const template = templates[type]

    // set default template if not set by config
    if (!template.body) template.body = blockedTemplates[type]

    template.idIndex = template.body.indexOf(templateKeyword)

    if (template.idIndex !== -1) {
      template.body = [
        template.body.slice(0, template.idIndex),
        template.body.slice(template.idIndex + templateKeyword.length),
      ]
    }
  }
}

function getTemplate (type, actionParameters) {
  const template = templates[type]
  if (template.idIndex === -1) return template

  const body = template.body[0] + (actionParameters?.security_response_id ?? '') + template.body[1]

  return { body, type: template.type }
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
  registerBlockDelegation,
  callBlockDelegation,
  specificBlockingTypes,
  getBlockingData,
  getBlockingAction,
  setTemplates,
  isBlocked,
  setDefaultBlockingActionParameters,
}
