'use strict'

const log = require('../log')
const blockedTemplates = require('./blocked_templates')

let templateHtml = blockedTemplates.html
let templateJson = blockedTemplates.json

function block (req, res, rootSpan, abortController) {
  if (res.headersSent) {
    log.warn('Cannot send blocking response when headers have already been sent')
    return
  }

  let type
  let body

  // parse the Accept header, ex: Accept: text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8
  const accept = req.headers.accept && req.headers.accept.split(',').map((str) => str.split(';', 1)[0].trim())

  if (accept && accept.includes('text/html') && !accept.includes('application/json')) {
    type = 'text/html'
    body = templateHtml
  } else {
    type = 'application/json'
    body = templateJson
  }

  rootSpan.addTags({
    'appsec.blocked': 'true'
  })

  res.statusCode = 403
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)

  if (abortController) {
    abortController.abort()
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

module.exports = {
  block,
  setTemplates
}
