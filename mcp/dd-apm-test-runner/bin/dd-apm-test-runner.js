#!/usr/bin/env node

'use strict'

const { Command } = require('commander')
const TestRunner = require('../src/index')

const program = new Command()

program
  .name('dd-apm-test-runner')
  .description('Run tests for dd-trace integrations with optional service dependencies')
  .version('1.0.0')

program
  .command('test')
  .description('Run tests for a specific plugin/integration')
  .argument('<plugin-id>', 'The normalized plugin ID (e.g., axios, redis, postgres)')
  .option('-s, --service <service>', 'Docker service to start before testing (e.g., redis, postgres, mongodb)')
  .option('--no-cleanup', 'Skip docker cleanup after tests')
  .option('--no-test-agent', 'Skip starting APM test agent')
  .option('--timeout <seconds>', 'Test timeout in seconds', '300')
  .option('--verbose', 'Show detailed output')
  .action(async (pluginId, options) => {
    try {
      const runner = new TestRunner({
        pluginId,
        service: options.service,
        cleanup: options.cleanup !== false,
        useTestAgent: options.testAgent !== false,
        timeout: parseInt(options.timeout) * 1000,
        verbose: options.verbose
      })

      const result = await runner.runTests()

      if (result.success) {
        console.log('✅ Tests completed successfully')
        process.exit(0)
      } else {
        console.log('❌ Tests failed')
        process.exit(1)
      }
    } catch (error) {
      console.error('Error running tests:', error.message)
      if (options.verbose) {
        console.error(error.stack)
      }
      process.exit(1)
    }
  })

program.parse()
