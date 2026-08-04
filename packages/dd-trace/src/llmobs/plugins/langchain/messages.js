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
  if (data == null) return ''

  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return data
  }

  if (data.constructor?.name === 'Object') {
    const formatted = {}
    for (const [key, value] of Object.entries(data)) {
      formatted[key] = formatIO(value)
    }
    return formatted
  }

  if (Array.isArray(data)) {
    return data.map(item => formatIO(item))
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
