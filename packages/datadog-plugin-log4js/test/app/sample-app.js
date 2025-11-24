'use strict'

/* eslint-disable no-console */

const log4js = require('log4js')

class Log4jsSampleApp {
  async setup () {
    // Configure log4js with various appenders
    log4js.configure({
      appenders: {
        console: { type: 'console' },
        file: { type: 'file', filename: '/tmp/log4js-sample.log' }
      },
      categories: {
        default: { appenders: ['console', 'file'], level: 'debug' },
        custom: { appenders: ['console'], level: 'info' }
      }
    })

    this.logger = log4js.getLogger()
    this.customLogger = log4js.getLogger('custom')
    console.log('✓ log4js configured successfully')
  }

  async teardown () {
    // Shutdown log4js to flush any pending logs
    log4js.shutdown((err) => {
      if (err) {
        console.error('✗ Error during shutdown:', err.message)
      } else {
        console.log('✓ log4js shutdown complete')
      }
    })
  }

  async basicLogging () {
    try {
      console.log('--- Testing basic logging levels ---')
      this.logger.trace('This is a trace message')
      this.logger.debug('This is a debug message')
      this.logger.info('This is an info message')
      this.logger.warn('This is a warning message')
      this.logger.error('This is an error message')
      this.logger.fatal('This is a fatal message')
      console.log('✓ Basic logging completed')
    } catch (error) {
      console.error(`✗ Error in basicLogging: ${error.message}`)
    }
  }

  async structuredLogging () {
    try {
      console.log('--- Testing structured logging ---')
      this.logger.info({ userId: 123, action: 'login' }, 'User logged in')
      this.logger.warn({ status: 'deprecated' }, 'Using deprecated API')
      this.logger.error({ errorCode: 'E500', stack: 'example' }, 'Server error occurred')
      console.log('✓ Structured logging completed')
    } catch (error) {
      console.error(`✗ Error in structuredLogging: ${error.message}`)
    }
  }

  async customCategoryLogging () {
    try {
      console.log('--- Testing custom category logging ---')
      this.customLogger.debug('This should not appear (below level)')
      this.customLogger.info('Custom category info message')
      this.customLogger.warn('Custom category warning')
      this.customLogger.error('Custom category error')
      console.log('✓ Custom category logging completed')
    } catch (error) {
      console.error(`✗ Error in customCategoryLogging: ${error.message}`)
    }
  }

  async formattedLogging () {
    try {
      console.log('--- Testing formatted logging ---')
      this.logger.info('User %s logged in from %s', 'john_doe', '192.168.1.1')
      this.logger.warn('Request took %dms', 1234)
      this.logger.error('Failed to connect to %s:%d', 'database.example.com', 5432)
      console.log('✓ Formatted logging completed')
    } catch (error) {
      console.error(`✗ Error in formattedLogging: ${error.message}`)
    }
  }

  async errorLogging () {
    try {
      console.log('--- Testing error logging ---')
      const testError = new Error('Test error for logging')
      testError.code = 'TEST_ERROR'
      this.logger.error('An error occurred:', testError)
      console.log('✓ Error logging completed')
    } catch (error) {
      console.error(`✗ Error in errorLogging: ${error.message}`)
    }
  }

  async runAll () {
    try {
      await this.setup()
      await this.basicLogging()
      await this.structuredLogging()
      await this.customCategoryLogging()
      await this.formattedLogging()
      await this.errorLogging()
      console.log('\n✓ All operations completed successfully')
    } catch (error) {
      console.error(`Fatal error: ${error.message}`)
      process.exit(1)
    } finally {
      await this.teardown()
      // Give shutdown time to complete
      setTimeout(() => process.exit(0), 100)
    }
  }
}

// Run it
const app = new Log4jsSampleApp()
app.runAll().catch(console.error)
