'use strict'

class LoggingReporter {
  onEnd () {
    // This is user output, despite matching Playwright's private reporter-error message.
    // eslint-disable-next-line no-console
    console.error('Error in reporter', new Error('user reporter diagnostic'))
  }
}

module.exports = LoggingReporter
