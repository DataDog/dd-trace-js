'use strict'

const request = require('../../exporters/common/request')
const log = require('../../log')
const Plugin = require('../../plugins/plugin')

/**
 * @typedef {object} LogSubmissionPayload
 * @property {string} source
 * @property {string | Record<string, unknown>} message
 */

/**
 * @param {import('../../config/config-base')} config
 * @returns {URL}
 */
function getLogSubmissionUrl (config) {
  const defaultUrl = new URL(`https://http-intake.logs.${config.site}`)

  if (!config.DD_AGENTLESS_LOG_SUBMISSION_URL) {
    return defaultUrl
  }

  try {
    return new URL(config.DD_AGENTLESS_LOG_SUBMISSION_URL)
  } catch {
    log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    return defaultUrl
  }
}

/**
 * @param {import('../../config/config-base')} config
 * @param {URL} url
 * @returns {object}
 */
function getWinstonLogSubmissionParameters (config, url) {
  const parameters = {
    host: url.hostname,
    path: `/api/v2/logs?ddsource=winston&service=${config.service}`,
    ssl: url.protocol === 'https:',
    headers: {
      'DD-API-KEY': config.DD_API_KEY,
    },
  }

  if (url.port) {
    parameters.port = url.port
  }

  return parameters
}

/**
 * @param {string | Record<string, unknown>} message
 * @returns {string | undefined}
 */
function serializeLogMessage (message) {
  if (typeof message === 'string') return message

  const ancestors = []
  return JSON.stringify(message, function (key, value) {
    if (value === null || typeof value !== 'object') return value

    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop()
    }

    if (ancestors.includes(value)) return '[Circular]'

    ancestors.push(value)
    return value
  })
}

class LogSubmissionPlugin extends Plugin {
  static id = 'log-submission'

  #logSubmissionUrl

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config, this.#logSubmissionUrl)))
    })

    this.addSub('ci:log-submission:log', (payload) => this.#submitLog(payload))
  }

  /**
   * @param {boolean | (Record<string, unknown> & { enabled: boolean })} config
   * @returns {void}
   */
  configure (config) {
    super.configure(config)
    this.#logSubmissionUrl = config !== null && typeof config === 'object' && config.enabled
      ? getLogSubmissionUrl(config)
      : undefined
  }

  /**
   * @param {LogSubmissionPayload} payload
   * @returns {void}
   */
  #submitLog ({ source, message }) {
    let serializedMessage
    try {
      serializedMessage = serializeLogMessage(message)
    } catch (error) {
      log.error('Could not serialize %s log for automatic submission', source, error)
      return
    }

    if (serializedMessage === undefined) return

    const options = {
      path: `/api/v2/logs?ddsource=${source}&service=${this.config.service}`,
      method: 'POST',
      headers: {
        'DD-API-KEY': this.config.DD_API_KEY,
        'Content-Type': 'application/json',
      },
      url: this.#logSubmissionUrl,
    }

    request(`[${serializedMessage}]`, options, (error) => {
      if (error) {
        log.error('Error submitting %s log', source, error)
      }
    })
  }
}

module.exports = LogSubmissionPlugin
