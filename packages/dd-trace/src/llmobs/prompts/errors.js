'use strict'

class PromptAPIError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, detail?: string}} options
   */
  constructor (message, { status = 0, detail } = {}) {
    super(message)
    this.name = 'PromptAPIError'
    this.status = status
    this.detail = detail
  }
}

module.exports = { PromptAPIError }
