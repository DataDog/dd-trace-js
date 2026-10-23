'use strict'

const { setTemplates } = require('../../src/appsec/blocking')

function getWebSpan (traces) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }

  throw new Error('Sanity check failed: web span not found', { cause: traces })
}

function createDeepObject (sheetValue, currentLevel = 1, max = 20) {
  if (currentLevel === max) {
    return {
      [`s-${currentLevel}`]: `s-${currentLevel}`,
      [`o-${currentLevel}`]: sheetValue,
    }
  }

  return {
    [`s-${currentLevel}`]: `s-${currentLevel}`,
    [`o-${currentLevel}`]: createDeepObject(sheetValue, currentLevel + 1, max),
  }
}

const blockedTemplateHtml = 'testBlockingHtml'
const blockedTemplateJson = '"testBlockingJson"'
const blockedTemplateGraphql = '"testBlockingGraphql"'

function setTestBlockingTemplates () {
  setTemplates({
    appsec: {
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML: blockedTemplateHtml,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON: blockedTemplateJson,
      DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON: blockedTemplateGraphql,
    },
  })
}

module.exports = {
  getWebSpan,
  createDeepObject,
  blockedTemplateHtml,
  blockedTemplateJson,
  blockedTemplateGraphql,
  setTestBlockingTemplates,
}
