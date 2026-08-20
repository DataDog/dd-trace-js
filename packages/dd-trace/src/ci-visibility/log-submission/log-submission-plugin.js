'use strict'

const request = require('../../exporters/common/request')
const log = require('../../log')
const Plugin = require('../../plugins/plugin')

/**
 * @param {import('../../config/config-base')} config
 * @param {string} source
 * @returns {string}
 */
function getLogSubmissionPath (config, source) {
  return `/api/v2/logs?${new URLSearchParams({ ddsource: source, service: config.service })}`
}

function getWinstonLogSubmissionParameters (config) {
  const { site, DD_API_KEY, DD_AGENTLESS_LOG_SUBMISSION_URL } = config
  const path = getLogSubmissionPath(config, 'winston')

  const defaultParameters = {
    host: `http-intake.logs.${site}`,
    path,
    ssl: true,
    headers: {
      'DD-API-KEY': DD_API_KEY,
    },
  }

  if (!DD_AGENTLESS_LOG_SUBMISSION_URL) {
    return defaultParameters
  }

  try {
    const url = new URL(DD_AGENTLESS_LOG_SUBMISSION_URL)
    return {
      host: url.hostname,
      port: url.port,
      ssl: url.protocol === 'https:',
      path,
      headers: defaultParameters.headers,
    }
  } catch {
    log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    return defaultParameters
  }
}

/**
 * @param {import('../../config/config-base')} config
 * @param {string} source
 * @returns {{ url: URL, path: string, method: string, headers: Record<string, string> } | undefined}
 */
function getLogSubmissionRequestOptions (config, source) {
  const headers = {
    'DD-API-KEY': config.DD_API_KEY,
    'Content-Type': 'application/json',
  }
  const path = getLogSubmissionPath(config, source)

  if (config.DD_AGENTLESS_LOG_SUBMISSION_URL) {
    try {
      return {
        url: new URL(config.DD_AGENTLESS_LOG_SUBMISSION_URL),
        path,
        method: 'POST',
        headers,
      }
    } catch {
      log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    }
  }

  try {
    return {
      url: new URL(`https://http-intake.logs.${config.site}`),
      path,
      method: 'POST',
      headers,
    }
  } catch {
    log.error('Could not parse automatic log submission site: %s', config.site)
  }
}

/**
 * @param {string | Record<string, unknown>} message
 * @returns {string}
 */
function serializeLogMessage (message) {
  return typeof message === 'string' ? message : JSON.stringify(message)
}

class LogSubmissionPlugin extends Plugin {
  static id = 'log-submission'

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config)))
    })

    this.addSub('ci:log-submission:log', (payload) => this.#submitLog(payload))
  }

  /**
   * Posts a correlated log record to the agentless logs intake.
   *
   * @param {{ source: string, message: string | Record<string, unknown> }} payload
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

    const options = getLogSubmissionRequestOptions(this.config, source)
    if (!options) return

    request(`[${serializedMessage}]`, options, error => {
      if (error) {
        log.error('Error submitting %s logs', source, error)
      }
    })
  }
}

module.exports = LogSubmissionPlugin
