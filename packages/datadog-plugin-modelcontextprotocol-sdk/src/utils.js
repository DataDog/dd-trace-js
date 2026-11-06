'use strict'

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'

function getFirstTextContent (content) {
  if (!Array.isArray(content)) return

  for (const item of content) {
    if (item.type === 'text' && item.text) return item.text
  }
}

function setErrorTags (span, message) {
  span.setTag('error', 1)
  span.setTag(ERROR_TYPE, 'Error')
  span.setTag(ERROR_MESSAGE, message)
}

function tagErrorResult (span, result) {
  if (result?.isError) {
    setErrorTags(span, getFirstTextContent(result.content) || 'Tool call returned isError: true')
  }
}

/**
 * Copies a plugin subscribed to an SDK 1.x Orchestrion channel onto the same channel of an SDK 2.x package.
 * The copy keeps the 1.x component, so span tags do not depend on the SDK major version.
 *
 * @template {{ id: string, prefix: string }} T
 * @param {T} Plugin
 * @param {string} packageName
 * @returns {T}
 */
function forPackage (Plugin, packageName) {
  return class extends Plugin {
    static id = `${Plugin.id}_${packageName.slice(packageName.lastIndexOf('/') + 1)}`
    static component = Plugin.id
    static prefix = Plugin.prefix.replace('@modelcontextprotocol/sdk', packageName)
  }
}

module.exports = {
  DISTRIBUTED_TRACE_META_KEY,
  forPackage,
  tagErrorResult,
}
