'use strict'

const log = require('../log')
const blockedTemplates = require('./blocked_templates')

let templateHtml = blockedTemplates.html
let templateJson = blockedTemplates.json
let blockingConfiguration

function blockWithRedirect (res, rootSpan, abortController) {
  rootSpan.addTags({
    'appsec.blocked': 'true'
  })

  let statusCode = blockingConfiguration.parameters.status_code
  if (!statusCode || statusCode < 300 || statusCode >= 400) {
    statusCode = 303
  }

  res.writeHead(statusCode, {
    'Location': blockingConfiguration.parameters.location
  }).end()

  if (abortController) {
    abortController.abort()
  }
}

function blockWithContent (req, res, rootSpan, abortController) {
  let type
  let body

  // parse the Accept header, ex: Accept: text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8
  const accept = req.headers.accept && req.headers.accept.split(',').map((str) => str.split(';', 1)[0].trim())

  if (!blockingConfiguration || blockingConfiguration.parameters.type === 'auto') {
    if (accept && accept.includes('text/html') && !accept.includes('application/json')) {
      type = 'text/html; charset=utf-8'
      body = templateHtml
    } else {
      type = 'application/json'
      body = templateJson
    }
  } else {
    if (blockingConfiguration.parameters.type === 'html') {
      type = 'text/html; charset=utf-8'
      body = templateHtml
    } else {
      type = 'application/json'
      body = templateJson
    }
  }

  rootSpan.addTags({
    'appsec.blocked': 'true'
  })

  if (blockingConfiguration && blockingConfiguration.type === 'block_request' &&
    blockingConfiguration.parameters.status_code) {
    res.statusCode = blockingConfiguration.parameters.status_code
  } else {
    res.statusCode = 403
  }
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)

  if (abortController) {
    abortController.abort()
  }
}

function block (req, res, rootSpan, abortController) {
  if (res.headersSent) {
    log.warn('Cannot send blocking response when headers have already been sent')
    return
  }

  if (blockingConfiguration && blockingConfiguration.type === 'redirect_request' &&
      blockingConfiguration.parameters.location) {
    blockWithRedirect(res, rootSpan, abortController)
  } else {
    blockWithContent(req, res, rootSpan, abortController)
  }
}

function setTemplates (config) {
  if (config.appsec.blockedTemplateHtml) {
    templateHtml = config.appsec.blockedTemplateHtml
  }
  if (config.appsec.blockedTemplateJson) {
    templateJson = config.appsec.blockedTemplateJson
  }
}

function updateBlockingConfiguration (newBlockingConfiguration) {
  blockingConfiguration = newBlockingConfiguration
}

module.exports = {
  block,
  setTemplates,
  updateBlockingConfiguration
}
