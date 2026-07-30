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
    if (Array.isArray(source.content)) {
      const { parts, hasImages } = walkContentBlocks(source.content)
      return partsToContent(parts, hasImages)
    }
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
 * @param {AnthropicDocumentBlock} block
 * @returns {string|Array<object>}
 */
function convertAnthropicDocumentBlock (block) {
  const metadata = []
  if (typeof block.title === 'string' && block.title) metadata.push(block.title)
  if (typeof block.context === 'string' && block.context) metadata.push(block.context)

  return combineMetadataWithBody(metadata, extractDocumentSource(block.source)) ?? FILE_FALLBACK
}

/**
 * @param {{parts: Array<object>, hasImages: boolean}} output
 * @param {string|Array<object>|undefined} content
 */
function appendContent (output, content) {
  if (Array.isArray(content)) {
    output.hasImages = true
    for (const part of content) output.parts.push(part)
  } else if (content !== undefined) {
    output.parts.push({ type: 'text', text: content })
  }
}

/**
 * Walks an Anthropic content-block array once and buckets each block by kind:
 * `parts` collects renderable content (text/image/document); `toolCalls` and
 * `toolResults` collect tool_use / tool_result blocks respectively.
 *
 * `search_result` blocks have their text inside `content: Array<TextBlockParam>`,
 * not a top-level `text` field; they are walked explicitly so RAG-injected text
 * reaches AI Guard for evaluation.
 * `thinking` / `redacted_thinking` are dropped — internal reasoning must not reach
 * AI Guard. Unknown block types fall through to a best-effort `text`-field extraction;
 * purely structural blocks without a `text` field are dropped silently.
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
  // `partsBeforeLastResult` records how many `parts` were collected before the last tool result,
  // so a caller can tell text that precedes the results from text that follows them.
  const out = { parts: [], toolCalls: [], toolResults: [], hasImages: false, partsBeforeLastResult: 0 }
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
      case 'document': {
        appendContent(out, convertAnthropicDocumentBlock(block))
        break
      }
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        // server_tool_use / mcp_tool_use are the built-in- and MCP-tool counterparts of tool_use.
        out.toolCalls.push({
          id: block.id ?? block.name,
          function: {
            name: block.name,
            arguments: stringifyOrEmpty(block.input),
          },
        })
        break
      case 'tool_result':
        out.partsBeforeLastResult = out.parts.length
        out.toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: convertAnthropicToolResultContent(block.content),
        })
        break
      case 'search_result': {
        // title and source are required, model-visible strings; include them so a prompt injection
        // placed in the metadata (not only the content) reaches AI Guard for evaluation.
        const metadata = []
        if (typeof block.title === 'string' && block.title) metadata.push(block.title)
        if (typeof block.source === 'string' && block.source) metadata.push(block.source)
        appendContent(out, combineMetadataWithBody(metadata, convertAnthropicBlocksToContent(block.content)))
        break
      }
      case 'web_fetch_tool_result': {
        // Emit as a tool result (like other *_tool_result blocks) so the call -> result -> final-text
        // timeline is preserved and the fetched document isn't merged into the assistant answer.
        out.partsBeforeLastResult = out.parts.length
        const content = block.content
        const resultContent = content?.type === 'web_fetch_result' && content.content
          ? convertAnthropicDocumentBlock(content.content)
          : convertServerToolResultContent(content)
        out.toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: resultContent,
        })
        break
      }
      case 'thinking':
      case 'redacted_thinking':
        break
      default:
        if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
          out.partsBeforeLastResult = out.parts.length
          out.toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: convertServerToolResultContent(block.content),
          })
        } else if (typeof block.text === 'string') {
          out.parts.push({ type: 'text', text: block.text })
        }
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
 * @param {Array<object>} parts
 * @returns {boolean}
 */
function hasImageParts (parts) {
  return parts.some(part => part.type === 'image_url')
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
 * @param {unknown} content
 * @returns {string}
 */
function convertServerToolResultContent (content) {
  if (typeof content === 'string') return content || '[tool result]'
  if (!content || typeof content !== 'object') return '[tool result]'
  if (typeof content.error_code === 'string') {
    return content.error_message ? `${content.error_code}: ${content.error_message}` : content.error_code
  }

  const lines = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      // text blocks (MCP / generic), then web-search title + url.
      if (typeof item.text === 'string') lines.push(item.text)
      if (typeof item.title === 'string') lines.push(item.title)
      if (typeof item.url === 'string') lines.push(item.url)
    }
  } else {
    if (typeof content.stdout === 'string' && content.stdout) lines.push(content.stdout)
    if (typeof content.stderr === 'string' && content.stderr) lines.push(content.stderr)
    if (typeof content.content === 'string' && content.content) lines.push(content.content)
    if (Array.isArray(content.lines)) {
      for (const line of content.lines) {
        if (typeof line === 'string') lines.push(line)
      }
    }
  }

  return lines.join('\n') || '[tool result]'
}

/**
 * Converts one turn's worth of content blocks (with no mid_conv_system among them) to normalized
 * messages under a single role.
 *
 * Assistant `tool_use` blocks become an assistant `tool_calls` message. Tool result blocks become
 * one `tool` message per block. When the segment calls a built-in server tool (call, result and
 * final text arrive together), the content-block timeline is preserved: the tool-call message and
 * any text before the last result come first, then the results, then text that follows them as a
 * separate assistant message — so the final answer stays last (`messages.at(-1)`) rather than being
 * moved ahead of the tool result. User turns carry only results, so those precede any accompanying
 * text. Text/image blocks are otherwise merged into a single message.
 *
 * @param {string} role
 * @param {Array<AnthropicContentBlock>} blocks
 * @returns {Array<object>}
 */
function convertContentSegment (role, blocks) {
  const { parts, toolCalls, toolResults, hasImages, partsBeforeLastResult } = walkContentBlocks(blocks)

  // Built-in server tool turn: keep the call -> result -> final-answer timeline.
  if (toolCalls.length && toolResults.length) {
    const leadingParts = parts.slice(0, partsBeforeLastResult)
    const trailingParts = parts.slice(partsBeforeLastResult)

    const callMessage = { role, tool_calls: toolCalls }
    const leadingContent = partsToContent(leadingParts, hasImageParts(leadingParts))
    if (leadingContent != null) callMessage.content = leadingContent

    const messages = [callMessage, ...toolResults]

    const trailingContent = partsToContent(trailingParts, hasImageParts(trailingParts))
    if (trailingContent != null) messages.push({ role, content: trailingContent })
    return messages
  }

  const messageContent = partsToContent(parts, hasImages)

  let assistantMessage
  if (messageContent != null || toolCalls.length) {
    assistantMessage = { role }
    if (messageContent != null) assistantMessage.content = messageContent
    if (toolCalls.length) assistantMessage.tool_calls = toolCalls
  }

  if (toolCalls.length) {
    return [assistantMessage]
  }

  const messages = [...toolResults]
  if (assistantMessage) messages.push(assistantMessage)
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
