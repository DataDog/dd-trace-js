'use strict'

class Log4jsTestSetup {
  async setup (module) {
    // Configure log4js with various appenders
    module.configure({
      appenders: {
        console: { type: 'console' },
        file: { type: 'file', filename: '/tmp/log4js-sample.log' }
      },
      categories: {
        default: { appenders: ['console', 'file'], level: 'debug' },
        custom: { appenders: ['console'], level: 'info' }
      }
    })

    this.logger = module.getLogger()
    this.customLogger = module.getLogger('custom')
  }

  async teardown () {
    // Shutdown log4js to flush any pending logs
    log4js.shutdown((err) => {
      if (err) {
      } else {
      }
    })
  }

  // --- Operations ---
}

module.exports = Log4jsTestSetup
