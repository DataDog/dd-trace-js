'use strict'

const { FILE_FALLBACK, IMAGE_FALLBACK, stringifyOrEmpty } = require('./utils')
/**
 * Converts an Anthropic image block to an `image_url` content part.
 *
 * @param {object} block
 * @returns {{type: 'image_url', image_url: {url: string}}|undefined}
 */
function convertAnthropicImageBlock (block) {
  const source = block.source
  if (!source || typeof source !== 'object') return
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  }
}

/**
 * Extracts the body content from a document block's source.
 * Inline `text` and `content` sources are normalized to their actual text; URL sources return the
 * URL; base64 / unknown sources return undefined (no readable body).
 *
 * @param {object|undefined} source
 * @returns {string|Array<object>|undefined}
 */
function extractDocumentSource (source) {
  if (!source) return
  // PlainTextSource stores inline text in `data`, not `text`.
  if (source.type === 'text' && typeof source.data === 'string') return source.data
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  if (source.type === 'content') {
    // ContentBlockSource.content is string | Array<ContentBlockSourceContent>.
    if (typeof source.content === 'string') return source.content
    if (Array.isArray(source.content)) return convertAnthropicBlocksToContent(source.content)
  }
}

/**
 * Combines model-visible metadata strings with an extracted body. When the body has images the
 * metadata becomes leading text parts and an array is returned; otherwise the metadata and a string
 * body are newline-joined. Returns undefined when there is nothing to include.
 *
 * @param {Array<string>} metadata
 * @param {string|Array<object>|undefined} body
 * @returns {string|Array<object>|undefined}
 */
function combineMetadataWithBody (metadata, body) {
  if (Array.isArray(body)) {
    const parts = metadata.map(text => ({ type: 'text', text }))
    for (const part of body) parts.push(part)
    return parts
  }

  const lines = [...metadata]
  if (typeof body === 'string') lines.push(body)
  return lines.length ? lines.join('\n') : undefined
}

/**
 * Extracts text from an Anthropic document block. The model-visible `title` and `context` are
 * combined with the source body so prompt-injections placed in document metadata — not just its
 * content — reach AI Guard. base64 / unknown sources fall back to the metadata or [file].
 *
 * @param {object} block
 * @returns {string|Array<object>}
 */
function convertAnthropicDocumentBlock (block) {
  const metadata = []
  if (typeof block.title === 'string' && block.title) metadata.push(block.title)
  if (typeof block.context === 'string' && block.context) metadata.push(block.context)

  return combineMetadataWithBody(metadata, extractDocumentSource(block.source)) ?? FILE_FALLBACK
}

/**
 * @param {Array<object>} items
 * @param {string|Array<object>|undefined} content
 */
function appendContent (items, content) {
  if (Array.isArray(content)) {
    for (const part of content) items.push(part)
  } else if (content !== undefined) {
    items.push({ type: 'text', text: content })
  }
}

/**
 * Walks Anthropic content blocks once and emits normalized content and tool events in source order.
 *
 * `search_result` blocks have their text inside `content: Array<TextBlockParam>`,
 * not a top-level `text` field; they are walked explicitly so RAG-injected text
 * reaches AI Guard for evaluation.
 * `thinking` / `redacted_thinking` are dropped — internal reasoning must not reach
 * AI Guard. Unknown block types fall through to a best-effort `text`-field extraction;
 * purely structural blocks without a `text` field are dropped silently.
 *
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
function walkContentBlocks (blocks) {
  const items = []
  if (!Array.isArray(blocks)) return items

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') items.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const image = convertAnthropicImageBlock(block)
        if (image) {
          items.push(image)
        } else {
          items.push({ type: 'text', text: IMAGE_FALLBACK })
        }
        break
      }
      case 'document': {
        appendContent(items, convertAnthropicDocumentBlock(block))
        break
      }
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        // server_tool_use / mcp_tool_use are the built-in- and MCP-tool counterparts of tool_use.
        items.push({
          kind: 'tool_call',
          value: {
            id: block.id ?? block.name,
            function: {
              name: block.name,
              arguments: stringifyOrEmpty(block.input),
            },
          },
        })
        break
      case 'tool_result':
        items.push({
          kind: 'tool_result',
          value: {
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: convertAnthropicToolResultContent(block.content),
          },
        })
        break
      case 'search_result': {
        // title and source are required, model-visible strings; include them so a prompt injection
        // placed in the metadata (not only the content) reaches AI Guard for evaluation.
        const metadata = []
        if (typeof block.title === 'string' && block.title) metadata.push(block.title)
        if (typeof block.source === 'string' && block.source) metadata.push(block.source)
        appendContent(items, combineMetadataWithBody(metadata, convertAnthropicBlocksToContent(block.content)))
        break
      }
      case 'web_fetch_tool_result': {
        // Emit as a tool result (like other *_tool_result blocks) so the call -> result -> final-text
        // timeline is preserved and the fetched document isn't merged into the assistant answer.
        const content = block.content
        const resultContent = content?.type === 'web_fetch_result' && content.content
          ? convertAnthropicDocumentBlock(content.content)
          : convertServerToolResultContent(content)
        items.push({
          kind: 'tool_result',
          value: {
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultContent,
          },
        })
        break
      }
      case 'thinking':
      case 'redacted_thinking':
        break
      default:
        if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
          items.push({
            kind: 'tool_result',
            value: {
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: convertServerToolResultContent(block.content),
            },
          })
        } else if (typeof block.text === 'string') {
          items.push({ type: 'text', text: block.text })
        }
        break
    }
  }
  return items
}

/**
 * Reduces walker `parts` to normalized message content: a plain string when
 * only text is present, an array of content parts when images are present,
 * or `undefined` when there is nothing to render.
 *
 * @param {Array<object>} parts
 * @param {boolean} hasImages
 * @returns {string|Array<object>|undefined}
 */
function partsToContent (parts, hasImages) {
  if (!parts.length) return
  if (hasImages) return parts
  let content = ''
  let isFirstPart = true
  for (const part of parts) {
    if (!isFirstPart) content += '\n'
    content += part.text
    isFirstPart = false
  }
  return content
}

/**
 * @param {Array<object>} parts
 * @returns {boolean}
 */
function hasImageParts (parts) {
  return parts.some(part => part.type === 'image_url')
}

/**
 * Converts Anthropic top-level `system` to a normalized system message.
 *
 * @param {string|Array<object>|undefined} system
 * @returns {{role: 'system', content: string|Array<object>}|undefined}
 */
function convertAnthropicSystem (system) {
  if (typeof system === 'string') {
    return system.length ? { role: 'system', content: system } : undefined
  }
  const content = convertAnthropicBlocksToContent(system)
  if (content != null) return { role: 'system', content }
}

/**
 * Converts a plain string or array of Anthropic content blocks into normalized message content.
 *
 * @param {string|Array<object>|undefined} blocks
 * @returns {string|Array<object>|undefined}
 */
function convertAnthropicBlocksToContent (blocks) {
  if (typeof blocks === 'string') return blocks
  const parts = []
  for (const item of walkContentBlocks(blocks)) {
    if (!item.kind) parts.push(item)
  }
  return partsToContent(parts, hasImageParts(parts))
}

/**
 * Converts an Anthropic tool_result block's content into a message content value.
 *
 * @param {string|Array<object>|undefined} content
 * @returns {string|Array<object>}
 */
function convertAnthropicToolResultContent (content) {
  return convertAnthropicBlocksToContent(content) ?? stringifyOrEmpty(content)
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function convertServerToolResultContent (content) {
  if (typeof content === 'string') return content || '[tool result]'
  if (!content || typeof content !== 'object') return '[tool result]'
  if (typeof content.error_code === 'string') {
    return content.error_message ? `${content.error_code}: ${content.error_message}` : content.error_code
  }

  let lines
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      // text blocks (MCP / generic), then web-search title + url.
      if (typeof item.text === 'string') {
        lines = lines === undefined ? item.text : `${lines}\n${item.text}`
      }
      if (typeof item.title === 'string') {
        lines = lines === undefined ? item.title : `${lines}\n${item.title}`
      }
      if (typeof item.url === 'string') {
        lines = lines === undefined ? item.url : `${lines}\n${item.url}`
      }
    }
  } else {
    if (typeof content.stdout === 'string' && content.stdout) lines = content.stdout
    if (typeof content.stderr === 'string' && content.stderr) {
      lines = lines === undefined ? content.stderr : `${lines}\n${content.stderr}`
    }
    if (typeof content.content === 'string' && content.content) {
      lines = lines === undefined ? content.content : `${lines}\n${content.content}`
    }
    if (Array.isArray(content.lines)) {
      for (const line of content.lines) {
        if (typeof line === 'string') {
          lines = lines === undefined ? line : `${lines}\n${line}`
        }
      }
    }
  }

  return lines || '[tool result]'
}

/**
 * @param {Array<object>} messages
 * @param {string} role
 * @param {Array<object>} parts
 * @param {Array<object>} toolCalls
 */
function appendPendingMessage (messages, role, parts, toolCalls) {
  const content = partsToContent(parts, hasImageParts(parts))
  if (content == null && !toolCalls.length) return

  const message = { role }
  if (content != null) message.content = content
  if (toolCalls.length) message.tool_calls = toolCalls
  messages.push(message)
}

/**
 * Converts one turn's worth of content blocks (with no mid_conv_system among them) to normalized
 * messages under a single role.
 *
 * Contiguous tool calls are grouped into one assistant message for parallel calls. Each tool result
 * with pending calls flushes those calls first, preserving sequential server-tool cycles. Standalone
 * user-supplied tool results remain ahead of accompanying user text.
 *
 * @param {string} role
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
function convertContentSegment (role, blocks) {
  const messages = []
  let parts = []
  let toolCalls = []

  for (const item of walkContentBlocks(blocks)) {
    if (item.kind === 'tool_call') {
      toolCalls.push(item.value)
    } else if (item.kind === 'tool_result') {
      if (toolCalls.length) {
        appendPendingMessage(messages, role, parts, toolCalls)
        parts = []
        toolCalls = []
      }
      messages.push(item.value)
    } else {
      parts.push(item)
    }
  }

  appendPendingMessage(messages, role, parts, toolCalls)
  return messages
}

/**
 * Converts a single Anthropic message to zero or more normalized messages.
 *
 * `mid_conv_system` blocks carry system-level instructions inserted at a point in the turn; each
 * becomes its own `{ role: 'system' }` message in place, so the content around it keeps its role
 * and chronology instead of the instruction being folded into (and mis-scored as) user/assistant
 * text. See {@link convertContentSegment} for how each surrounding segment is converted.
 *
 * @param {{role: string, content: string|Array<object>}} message
 * @returns {Array<object>}
 */
function convertAnthropicMessage (message) {
  if (!message || typeof message !== 'object') return []
  const { role, content } = message

  if (typeof content === 'string') {
    return content.length ? [{ role, content }] : []
  }
  if (!Array.isArray(content)) return []

  const messages = []
  let segment = []
  for (const block of content) {
    if (block?.type === 'mid_conv_system') {
      for (const converted of convertContentSegment(role, segment)) messages.push(converted)
      segment = []
      const systemContent = convertAnthropicBlocksToContent(block.content)
      if (systemContent != null) messages.push({ role: 'system', content: systemContent })
    } else {
      segment.push(block)
    }
  }
  for (const converted of convertContentSegment(role, segment)) messages.push(converted)
  return messages
}

/**
 * Extracts input messages from an Anthropic `messages.create` call.
 *
 * @param {{system?: string|Array<object>, messages?: Array<object>}|undefined} callArgs
 * @returns {Array<object>|undefined}
 */
function getMessagesInputMessages (callArgs) {
  const raw = callArgs?.messages
  if (!Array.isArray(raw)) return

  const result = []
  const system = convertAnthropicSystem(callArgs.system)
  if (system) result.push(system)

  for (const message of raw) {
    const converted = convertAnthropicMessage(message)
    for (const m of converted) result.push(m)
  }

  return result.length ? result : undefined
}

/**
 * Extracts output messages from an Anthropic `messages.create` parsed response body.
 *
 * @param {{role?: string, content?: Array<object>}|undefined} body
 * @returns {Array<object>}
 */
function getMessagesOutputMessages (body) {
  if (!body || typeof body !== 'object') return []
  const role = body.role || 'assistant'
  return convertAnthropicMessage({ role, content: body.content })
}

module.exports = {
  convertAnthropicSystem,
  convertAnthropicBlocksToContent,
  convertAnthropicMessage,
  getMessagesInputMessages,
  getMessagesOutputMessages,
}
