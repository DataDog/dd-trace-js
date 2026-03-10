'use strict'

const LLMObsPlugin = require('../base')

const TOOL = 'tool'
const RETRIEVAL = 'retrieval'

/**
 * Base LLMObs plugin for MCP (Model Context Protocol) client operations.
 *
 * MCP is a protocol that enables AI models to interact with external tools,
 * resources, and prompts. Each operation maps to an LLMObs span kind:
 * - callTool → tool
 * - getResource → retrieval
 * - getPrompt → retrieval
 * - complete → tool
 */
class BaseMcpClientLLMObsPlugin extends LLMObsPlugin {
  static integration = 'mcp-client'

  /**
   * Returns span registration options for the MCP operation.
   * Subclasses set `mcpSpanKind` and `mcpOperationName` to customize.
   *
   * @param {object} ctx - Plugin context
   * @returns {{ kind: string, name: string } | undefined}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const params = ctx.arguments?.[0]
    const name = this.#getOperationName(params)

    return {
      kind: this.constructor.mcpSpanKind,
      name,
    }
  }

  /**
   * Extracts and tags LLMObs data from the MCP operation.
   *
   * @param {object} ctx - Plugin context with arguments and result
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const result = ctx.result
    const error = !!span.context()._tags.error || !!ctx.error

    const metadata = this.#extractMetadata(ctx)
    this._tagger.tagMetadata(span, metadata)

    this.tagOperation(span, params, result, error)
  }

  /**
   * Tags the specific operation data. Subclasses override this.
   *
   * @param {object} span - The active span
   * @param {object} params - The operation parameters
   * @param {object} result - The operation result
   * @param {boolean} error - Whether the operation errored
   */
  tagOperation (span, params, result, error) {
    // Default: tag text IO with stringified params/result
    const input = params ? JSON.stringify(params) : ''
    const output = error ? '' : (result ? JSON.stringify(result) : '')
    this._tagger.tagTextIO(span, input, output)
  }

  /**
   * Builds the operation name from parameters.
   *
   * @param {object} params - The operation parameters
   * @returns {string}
   */
  #getOperationName (params) {
    const baseName = this.constructor.mcpOperationName
    const identifier = this.#getResourceIdentifier(params)
    return identifier ? `${baseName} ${identifier}` : baseName
  }

  /**
   * Extracts a human-readable identifier from params for the operation name.
   *
   * @param {object} params - The operation parameters
   * @returns {string|undefined}
   */
  #getResourceIdentifier (params) {
    if (!params) return undefined
    return params.name || params.uri || params.ref?.name
  }

  /**
   * Extracts metadata from the MCP context including server info.
   *
   * @param {object} ctx - Plugin context
   * @returns {object}
   */
  #extractMetadata (ctx) {
    const metadata = {}
    const serverName = ctx.self?.client?.getServerVersion?.()?.name
    if (serverName) {
      metadata['mcp.server.name'] = serverName
    }

    const serverVersion = ctx.self?.client?.getServerVersion?.()?.version
    if (serverVersion) {
      metadata['mcp.server.version'] = serverVersion
    }

    return metadata
  }
}

/**
 * LLMObs plugin for MCP callTool operations.
 * Maps to span kind: tool
 */
class McpClientCallToolLLMObsPlugin extends BaseMcpClientLLMObsPlugin {
  static id = 'llmobs_mcp_client_call_tool'
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_callTool'
  static mcpSpanKind = TOOL
  static mcpOperationName = 'mcp-client.callTool'

  /**
   * @param {object} span
   * @param {object} params - { name, arguments }
   * @param {object} result - { content: [{ type, text }], isError }
   * @param {boolean} error
   */
  tagOperation (span, params, result, error) {
    // MCP protocol can return isError in the result content without throwing
    const mcpError = error || result?.isError
    const input = this.#formatToolInput(params)
    const output = mcpError ? '' : this.#formatToolOutput(result)
    this._tagger.tagTextIO(span, input, output)
  }

  /**
   * Formats tool input from callTool params.
   *
   * @param {object} params - { name, arguments }
   * @returns {string}
   */
  #formatToolInput (params) {
    if (!params) return ''
    const parts = []
    if (params.name) {
      parts.push(`tool: ${params.name}`)
    }
    if (params.arguments) {
      parts.push(`arguments: ${JSON.stringify(params.arguments)}`)
    }
    return parts.join(', ') || ''
  }

  /**
   * Formats tool output from callTool result.
   *
   * @param {object} result - { content: [{ type, text }], isError }
   * @returns {string}
   */
  #formatToolOutput (result) {
    if (!result) return ''
    if (result.isError) return ''

    const content = result.content
    if (!Array.isArray(content)) return ''

    const textParts = []
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      }
    }
    return textParts.join('\n')
  }
}

/**
 * LLMObs plugin for MCP getResource operations.
 * Maps to span kind: retrieval
 */
class McpClientGetResourceLLMObsPlugin extends BaseMcpClientLLMObsPlugin {
  static id = 'llmobs_mcp_client_get_resource'
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_getResource'
  static mcpSpanKind = RETRIEVAL
  static mcpOperationName = 'mcp-client.getResource'

  /**
   * @param {object} span
   * @param {object} params - { uri }
   * @param {object} result - { contents: [{ uri, mimeType, text }] }
   * @param {boolean} error
   */
  tagOperation (span, params, result, error) {
    const input = params?.uri || ''

    if (error) {
      this._tagger.tagRetrievalIO(span, input)
      return
    }

    const documents = this.#formatResourceDocuments(result)
    this._tagger.tagRetrievalIO(span, input, documents)
  }

  /**
   * Formats resource result as retrieval documents.
   *
   * @param {object} result - { contents: [{ uri, mimeType, text }] }
   * @returns {Array<{ text: string, name: string }>}
   */
  #formatResourceDocuments (result) {
    if (!result?.contents || !Array.isArray(result.contents)) return []

    const documents = []
    for (const content of result.contents) {
      documents.push({
        text: content.text || '',
        name: content.uri || '',
      })
    }
    return documents
  }
}

/**
 * LLMObs plugin for MCP getPrompt operations.
 * Maps to span kind: retrieval
 */
class McpClientGetPromptLLMObsPlugin extends BaseMcpClientLLMObsPlugin {
  static id = 'llmobs_mcp_client_get_prompt'
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_getPrompt'
  static mcpSpanKind = RETRIEVAL
  static mcpOperationName = 'mcp-client.getPrompt'

  /**
   * @param {object} span
   * @param {object} params - { name, arguments }
   * @param {object} result - { messages: [{ role, content: { type, text } }] }
   * @param {boolean} error
   */
  tagOperation (span, params, result, error) {
    const input = params?.name || ''

    if (error) {
      this._tagger.tagRetrievalIO(span, input)
      return
    }

    const documents = this.#formatPromptDocuments(result)
    this._tagger.tagRetrievalIO(span, input, documents)
  }

  /**
   * Formats prompt result as retrieval documents.
   *
   * @param {object} result - { messages: [{ role, content: { type, text } }] }
   * @returns {Array<{ text: string, name: string }>}
   */
  #formatPromptDocuments (result) {
    if (!result?.messages || !Array.isArray(result.messages)) return []

    const documents = []
    for (const message of result.messages) {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content?.text || ''
      documents.push({
        text,
        name: message.role || '',
      })
    }
    return documents
  }
}

/**
 * LLMObs plugin for MCP complete (autocomplete) operations.
 * Maps to span kind: tool
 */
class McpClientCompleteLLMObsPlugin extends BaseMcpClientLLMObsPlugin {
  static id = 'llmobs_mcp_client_complete'
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_complete'
  static mcpSpanKind = TOOL
  static mcpOperationName = 'mcp-client.complete'

  /**
   * @param {object} span
   * @param {object} params - { ref: { type, name }, argument: { name, value } }
   * @param {object} result - { completion: { values: string[], hasMore, total } }
   * @param {boolean} error
   */
  tagOperation (span, params, result, error) {
    const input = this.#formatCompleteInput(params)
    const output = error ? '' : this.#formatCompleteOutput(result)
    this._tagger.tagTextIO(span, input, output)
  }

  /**
   * Formats completion input from params.
   *
   * @param {object} params - { ref: { type, name }, argument: { name, value } }
   * @returns {string}
   */
  #formatCompleteInput (params) {
    if (!params) return ''
    const parts = []
    if (params.ref?.type) {
      parts.push(`ref.type: ${params.ref.type}`)
    }
    if (params.ref?.name) {
      parts.push(`ref.name: ${params.ref.name}`)
    }
    if (params.argument?.name) {
      parts.push(`argument.name: ${params.argument.name}`)
    }
    if (params.argument?.value) {
      parts.push(`argument.value: ${params.argument.value}`)
    }
    return parts.join(', ') || ''
  }

  /**
   * Formats completion output from result.
   * The MCP SDK returns { completion: { values: string[], hasMore?, total? } }
   * but ctx.result may have varying structure depending on SDK version.
   *
   * @param {object} result - { completion: { values: string[], hasMore, total } }
   * @returns {string}
   */
  #formatCompleteOutput (result) {
    if (!result) return ''

    // Try to find values array in various locations
    const values = this.#findCompletionValues(result)
    if (values && values.length > 0) {
      return values.join(', ')
    }

    // Fallback: stringify the entire result for visibility
    try {
      const str = JSON.stringify(result)
      if (str && str !== '{}' && str !== 'null') return str
    } catch {
      // ignore stringify errors
    }

    return ''
  }

  /**
   * Searches for the completion values array in the result object.
   * Handles multiple possible structures from the MCP SDK.
   *
   * @param {object} result
   * @returns {string[]|undefined}
   */
  #findCompletionValues (result) {
    // Standard path: result.completion.values
    if (Array.isArray(result?.completion?.values)) {
      return result.completion.values
    }

    // Maybe result IS the completion object: result.values
    if (Array.isArray(result?.values)) {
      return result.values
    }

    // Maybe completion is at a different nesting level
    if (result && typeof result === 'object') {
      for (const key of Object.keys(result)) {
        const val = result[key]
        if (val && typeof val === 'object' && Array.isArray(val.values)) {
          return val.values
        }
      }
    }

    return undefined
  }
}

module.exports = [
  McpClientCallToolLLMObsPlugin,
  McpClientGetResourceLLMObsPlugin,
  McpClientGetPromptLLMObsPlugin,
  McpClientCompleteLLMObsPlugin,
]
