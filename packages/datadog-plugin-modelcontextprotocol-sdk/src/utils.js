'use strict'

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'

function joinValues (items, property) {
  let values = ''
  for (const item of items) {
    const value = item[property]
    if (value) {
      if (values) values += ','
      values += value
    }
  }
  return values
}

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

function tagArgumentKeys (span, args) {
  const keys = Object.keys(args)
  const count = keys.length
  if (!count) return

  span.setTag('mcp.request.argument_count', count)
  span.setTag('mcp.request.argument_keys', keys.join(','))
}

function tagRequestParams (span, request) {
  const params = request?.params
  if (!params) return
  if (params.name) {
    span.setTag(request.method === 'prompts/get' ? 'mcp.prompt.name' : 'mcp.tool.name', params.name)
  }
  if (params.uri) span.setTag('mcp.resource.uri', params.uri)
  if (params.arguments) tagArgumentKeys(span, params.arguments)
}

function tagRequestResult (span, result, tagError) {
  if (!result) return
  const isError = tagError && result.isError
  let errorMessage

  if (Array.isArray(result.tools)) {
    const toolNames = joinValues(result.tools, 'name')
    if (toolNames) span.setTag('mcp.tool.names', toolNames)
  }
  if (Array.isArray(result.resources)) {
    const resourceUris = joinValues(result.resources, 'uri')
    if (resourceUris) span.setTag('mcp.resource.uris', resourceUris)
  }
  if (Array.isArray(result.prompts)) {
    let promptNames = ''
    let promptDescriptions = ''
    for (const prompt of result.prompts) {
      if (prompt.name) {
        if (promptNames) promptNames += ','
        promptNames += prompt.name
      }
      if (prompt.description) {
        if (promptDescriptions) promptDescriptions += ','
        promptDescriptions += prompt.description
      }
    }

    if (promptNames) span.setTag('mcp.prompt.names', promptNames)
    if (promptDescriptions) span.setTag('mcp.prompt.descriptions', promptDescriptions)
  }
  if (Array.isArray(result.content)) {
    span.setTag('mcp.tool.response.content_count', result.content.length)

    let contentTypes = ''
    for (const item of result.content) {
      if (item.type) {
        if (contentTypes) contentTypes += ','
        contentTypes += item.type
      }
      if (isError && errorMessage === undefined && item.type === 'text' && item.text) {
        errorMessage = item.text
      }
    }

    if (contentTypes) span.setTag('mcp.tool.response.content_types', contentTypes)
  }

  if (isError) {
    setErrorTags(span, errorMessage || 'Tool call returned isError: true')
  }
}

module.exports = {
  DISTRIBUTED_TRACE_META_KEY,
  tagErrorResult,
  tagRequestParams,
  tagRequestResult,
}
