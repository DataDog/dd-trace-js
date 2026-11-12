'use strict'

class ThrowingReporter {
  onBegin () {
    if (!process.env.PLAYWRIGHT_REPORTER_IMMUTABLE_CONSOLE_ERROR) return

    this.consoleErrorDescriptor = Object.getOwnPropertyDescriptor(console, 'error')
    Object.defineProperty(console, 'error', {
      ...this.consoleErrorDescriptor,
      writable: false,
    })
  }

  onEnd () {
    if (process.env.PLAYWRIGHT_REPORTER_IMMUTABLE_CONSOLE_ERROR) {
      Object.defineProperty(console, 'error', this.consoleErrorDescriptor)
      return
    }
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_ON_EXIT) return
    if (process.env.PLAYWRIGHT_REPORTER_CUSTOM_STACK) {
      Error.prepareStackTrace = (error, callSites) => error.message === 'Playwright reporter error provenance'
        ? ({ custom: 'stack' })
        : `${error.name}: ${error.message}\n${callSites.join('\n')}`
    }
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_NULL) {
      // eslint-disable-next-line no-throw-literal
      throw null
    }
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_HOSTILE_OBJECT) {
      throw new Proxy({}, {
        get () {
          throw new Error('reporter property access failed')
        },
      })
    }
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_UNDEFINED) {
      // eslint-disable-next-line no-throw-literal
      throw undefined
    }
    throw new Error('custom Playwright reporter failed')
  }

  onExit () {
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_ON_EXIT) {
      throw new Error('custom Playwright reporter onExit failed')
    }
  }
}

module.exports = ThrowingReporter
