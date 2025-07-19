'use strict'

require('../../setup/mocha')

const assert = require('node:assert')

describe('worker thread logger', function () {
  it('should log to the provided message channel', function (done) {
    const logChannel = new MessageChannel()
    const log = proxyquire('../src/debugger/devtools_client/log', {
      'node:worker_threads': {
        workerData: { logPort: logChannel.port1, config: { debug: true, logLevel: 'debug' } }
      }
    })

    const expected = [
      { level: 'error', args: ['test1'] },
      { level: 'warn', args: ['test2'] },
      { level: 'info', args: ['test3'] },
      { level: 'debug', args: ['test4'] }
    ]

    logChannel.port2.on('message', (message) => {
      assert.deepStrictEqual(message, expected.shift())
      if (expected.length === 0) done()
    })

    log.error('test1')
    log.warn('test2')
    log.info('test3')
    log.debug('test4')
  })

  it('should respect the debug flag', function (done) {
    const logChannel = new MessageChannel()
    const log = proxyquire('../src/debugger/devtools_client/log', {
      'node:worker_threads': {
        workerData: { logPort: logChannel.port1, config: { debug: false, logLevel: 'debug' } }
      }
    })

    logChannel.port2.on('message', () => {
      throw new Error('should not have logged')
    })

    log.error('test1')
    log.warn('test2')
    log.info('test3')
    log.debug('test4')

    setImmediate(done)
  })

  it('should should resolve the function argument', function (done) {
    const logChannel = new MessageChannel()
    const log = proxyquire('../src/debugger/devtools_client/log', {
      'node:worker_threads': {
        workerData: { logPort: logChannel.port1, config: { debug: true, logLevel: 'debug' } }
      }
    })

    logChannel.port2.on('message', (message) => {
      assert.deepStrictEqual(message, { level: 'debug', args: ['logged'] })
      done()
    })

    const message = 'logged'
    log.debug(() => message)
  })

  describe('log level', function () {
    it('info', checkLogLevel('info', ['error', 'warn', 'info']))

    it('warn', checkLogLevel('warn', ['error', 'warn']))

    it('error', checkLogLevel('error', ['error']))
  })
})

function checkLogLevel (level, expectedLevels) {
  const levels = ['error', 'warn', 'info', 'debug']

  return function (done) {
    const logChannel = new MessageChannel()
    const log = proxyquire('../src/debugger/devtools_client/log', {
      'node:worker_threads': {
        workerData: { logPort: logChannel.port1, config: { debug: true, logLevel: level } }
      }
    })

    const expected = expectedLevels.map((level) => ({ level, args: ['logged'] }))

    logChannel.port2.on('message', (message) => {
      assert.deepStrictEqual(message, expected.shift())
      if (expected.length === 0) done()
    })

    for (const level of expectedLevels) {
      log[level]('logged')
    }

    for (const level of levels) {
      if (!expectedLevels.includes(level)) {
        log[level]('not logged')
      }
    }
  }
}
