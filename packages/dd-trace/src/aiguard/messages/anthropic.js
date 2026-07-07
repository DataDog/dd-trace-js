'use strict'

const { FILE_FALLBACK, IMAGE_FALLBACK, stringifyOrEmpty } = require('./utils')
/**
 * Converts an Anthropic image block to an `image_url` content part.
 *
 * @param {AnthropicImageBlock} block
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
 * Extracts text from an Anthropic document block.
 * Inline `text` and `content` sources are normalized to their actual text so
 * prompt-injections embedded in document content reach AI Guard for evaluation.
 * URL sources return the URL; base64 / unknown sources fall back to title or [file].
 *
 * @param {AnthropicDocumentBlock} block
 * @returns {string|Array<object>}
 */
function convertAnthropicDocumentBlock (block) {
  const source = block.source
  if (source) {
    if (source.type === 'text' && typeof source.text === 'string') return source.text
    if (source.type === 'url' && typeof source.url === 'string') return source.url
    if (source.type === 'content' && Array.isArray(source.content)) {
      const { parts, hasImages } = walkContentBlocks(source.content)
      const content = partsToContent(parts, hasImages)
      if (content != null) return content
    }
  }
  return block.title ?? FILE_FALLBACK
}

/**
 * Walks an Anthropic content-block array once and buckets each block by kind:
 * `parts` collects renderable content (text/image/document); `toolCalls` and
 * `toolResults` collect tool_use / tool_result blocks respectively.
 *
 * `thinking` / `redacted_thinking` and any unknown block types are dropped —
 * internal reasoning is not conversation, and speculative shape mapping for
 * newer block types (server_tool_use, mcp_tool_*, etc.) risks misleading AI
 * Guard, which is trained on chat-style shapes.
 *
 * @param {Array<AnthropicContentBlock>} blocks
 * @returns {{
 *   parts: Array<{type: string, text?: string, image_url?: {url: string}}>,
 *   toolCalls: Array<{id: string, function: {name: string, arguments: string}}>,
 *   toolResults: Array<{role: 'tool', tool_call_id: string, content: string|Array<object>}>,
 *   hasImages: boolean
 * }}
 */
function walkContentBlocks (blocks) {
  const out = { parts: [], toolCalls: [], toolResults: [], hasImages: false }
  if (!Array.isArray(blocks)) return out

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') out.parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const image = convertAnthropicImageBlock(block)
        if (image) {
          out.hasImages = true
          out.parts.push(image)
        } else {
          out.parts.push({ type: 'text', text: IMAGE_FALLBACK })
        }
        break
      }
      case 'document':
        out.parts.push({ type: 'text', text: convertAnthropicDocumentBlock(block) })
        break
      case 'tool_use':
        out.toolCalls.push({
          id: block.id ?? block.name,
          function: {
            name: block.name,
            arguments: stringifyOrEmpty(block.input),
          },
        })
        break
      case 'tool_result':
        out.toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: convertAnthropicToolResultContent(block.content),
        })
        break
    }
  }
  return out
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
  return parts.map(p => p.text).join('\n')
}

/**
 * Converts Anthropic top-level `system` to a normalized system message.
 *
 * @param {string|Array<AnthropicContentBlock>|undefined} system
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
 * @param {string|Array<AnthropicContentBlock>|undefined} blocks
 * @returns {string|Array<object>|undefined}
 */
function convertAnthropicBlocksToContent (blocks) {
  if (typeof blocks === 'string') return blocks
  const { parts, hasImages } = walkContentBlocks(blocks)
  return partsToContent(parts, hasImages)
}

/**
 * Converts an Anthropic tool_result block's content into a message content value.
 *
 * @param {string|Array<AnthropicContentBlock>|undefined} content
 * @returns {string|Array<object>}
 */
function convertAnthropicToolResultContent (content) {
  return convertAnthropicBlocksToContent(content) ?? stringifyOrEmpty(content)
}

/**
 * Converts a single Anthropic message to zero or more normalized messages.
 * Assistant `tool_use` blocks become an assistant `tool_calls` message.
 * User `tool_result` blocks become one `tool` message per block, emitted
 * before any accompanying text so the chat-style timeline is preserved.
 * Text/image blocks are merged into a single message per role.
 *
 * @param {{role: string, content: string|Array<AnthropicContentBlock>}} message
 * @returns {Array<object>}
 */
function convertAnthropicMessage (message) {
  if (!message || typeof message !== 'object') return []
  const { role, content } = message

  if (typeof content === 'string') {
    return content.length ? [{ role, content }] : []
  }
  if (!Array.isArray(content)) return []

  const { parts, toolCalls, toolResults, hasImages } = walkContentBlocks(content)
  const messages = [...toolResults]
  const messageContent = partsToContent(parts, hasImages)

  if (messageContent != null) {
    if (toolCalls.length) {
      messages.push({ role, content: messageContent, tool_calls: toolCalls })
    } else {
      messages.push({ role, content: messageContent })
    }
  } else if (toolCalls.length) {
    messages.push({ role, tool_calls: toolCalls })
  }

  return messages
}

/**
 * Extracts input messages from an Anthropic `messages.create` call.
 *
 * @param {{system?: string|Array<AnthropicContentBlock>, messages?: Array<object>}|undefined} callArgs
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
 * @param {{role?: string, content?: Array<AnthropicContentBlock>}|undefined} body
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
