'use strict'

const ROLE_MAPPINGS = {
  human: 'user',
  ai: 'assistant',
  system: 'system',
}

function getRole (message) {
  if (message.role) return ROLE_MAPPINGS[message.role] || message.role

  const type = (
    (typeof message.getType === 'function' && message.getType()) ||
    (typeof message._getType === 'function' && message._getType())
  )

  return ROLE_MAPPINGS[type] || type
}

function getContentFromMessage (message) {
  if (typeof message === 'string') {
    return message
  }
  try {
    const messageContent = {
      content: message.content || '',
    }

    const role = getRole(message)
    if (role) messageContent.role = role

    return messageContent
  } catch {
    return JSON.stringify(message)
  }
}

function isBaseMessage (data) {
  return typeof data._getType === 'function' || typeof data.getType === 'function'
}

function formatIO (data) {
  return formatIOInternal(data, new WeakSet())
}

// LangChain `Document`/state graphs can carry cycles (e.g. parent <-> child
// linked nodes); without the WeakSet guard, the recursion blows the stack
// before the JSON.stringify fallback catches.
function formatIOInternal (data, seen) {
  if (data == null) return ''

  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return data
  }

  if (typeof data === 'object') {
    if (seen.has(data)) return '[Circular]'
    seen.add(data)
  }

  if (data.constructor?.name === 'Object') {
    const formatted = {}
    for (const key of Object.keys(data)) {
      formatted[key] = formatIOInternal(data[key], seen)
    }
    return formatted
  }

  if (Array.isArray(data)) {
    const out = new Array(data.length)
    for (let i = 0; i < data.length; i++) {
      out[i] = formatIOInternal(data[i], seen)
    }
    return out
  }

  // Only duck-typed BaseMessage instances collapse to { content, role }.
  // Other class instances (e.g. LangChain Document) preserve their shape via JSON.stringify,
  // otherwise they'd reduce to { content: '' } and lose data.
  if (isBaseMessage(data)) return getContentFromMessage(data)

  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

module.exports = {
  getRole,
  formatIO,
}
