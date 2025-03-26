const Plugin = require('../../plugins/plugin')
const log = require('../../log')

function getWinstonLogSubmissionParameters (config) {
  const { site, service } = config

  const defaultParameters = {
    host: `http-intake.logs.${site}`,
    path: `/api/v2/logs?ddsource=winston&service=${service}`,
    ssl: true,
    headers: {
      'DD-API-KEY': process.env.DD_API_KEY
    }
  }

  if (!process.env.DD_AGENTLESS_LOG_SUBMISSION_URL) {
    return defaultParameters
  }

  try {
    const url = new URL(process.env.DD_AGENTLESS_LOG_SUBMISSION_URL)
    return {
      host: url.hostname,
      port: url.port,
      ssl: url.protocol === 'https:',
      path: defaultParameters.path,
      headers: defaultParameters.headers
    }
  } catch (e) {
    log.error('Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    return defaultParameters
  }
}

class LogSubmissionPlugin extends Plugin {
  static get id () {
    return 'log-submission'
  }

  constructor (...args) {
    super(...args)

    this.addSub('ci:log-submission:winston:configure', (httpClass) => {
      this.HttpClass = httpClass
    })

    this.addSub('ci:log-submission:winston:add-transport', (logger) => {
      logger.add(new this.HttpClass(getWinstonLogSubmissionParameters(this.config)))
    })
  }
}

module.exports = LogSubmissionPlugin
