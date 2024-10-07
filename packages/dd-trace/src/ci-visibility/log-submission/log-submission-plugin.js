const Plugin = require('../../plugins/plugin')

function getWinstonLogSubmissionParameters (config) {
  const { site, service } = config
  return {
    host: `http-intake.logs.${site}`,
    path: `/api/v2/logs?dd-api-key=${process.env.DD_API_KEY}&ddsource=winston&service=${service}`,
    ssl: true
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
