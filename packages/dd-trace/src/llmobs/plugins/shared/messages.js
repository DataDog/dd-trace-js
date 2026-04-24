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

  return getContentFromMessage(data)
}

module.exports = {
  ROLE_MAPPINGS,
  getRole,
  getContentFromMessage,
  formatIO,
}
