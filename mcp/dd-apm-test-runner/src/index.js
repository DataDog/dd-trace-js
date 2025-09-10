'use strict'

const { spawn } = require('child_process')
const fs = require('fs').promises
const path = require('path')

// Common services that require Docker
const SERVICE_DEPENDENCIES = {
  redis: 'redis',
  postgres: 'postgres',
  postgresql: 'postgres',
  mongodb: 'mongo',
  mongo: 'mongo',
  mysql: 'mysql',
  elasticsearch: 'elasticsearch',
  rabbitmq: 'rabbitmq',
  kafka: 'kafka',
  cassandra: 'cassandra',
  memcached: 'memcached'
}

// APM Test Agent configuration
const APM_TEST_AGENT_CONFIG = {
  service: 'testagent',
  port: 8126,
  healthEndpoint: 'http://localhost:8126/test/session/start'
}

class TestRunner {
  constructor (options) {
    this.pluginId = options.pluginId
    this.service = options.service
    this.cleanup = options.cleanup !== false
    this.timeout = options.timeout || 300000 // 5 minutes default
    this.verbose = options.verbose || false
    this.workspaceRoot = process.cwd()
    this.useTestAgent = options.useTestAgent !== false // Default to true
    this.testAgentStarted = false
  }

  async runTests () {
    const result = {
      pluginId: this.pluginId,
      service: this.service,
      success: false,
      steps: [],
      output: '',
      error: null,
      duration: 0,
      testResults: null
    }

    const startTime = Date.now()

    try {
      // Step 1: Start APM Test Agent if needed
      if (this.useTestAgent) {
        const testAgentStep = await this.startTestAgent()
        result.steps.push(testAgentStep)

        if (!testAgentStep.success) {
          result.error = `Failed to start APM test agent: ${testAgentStep.error}`
          return result
        }
      }

      // Step 2: Determine if service is needed
      const needsService = await this.determineServiceNeeds()
      if (needsService && !this.service) {
        this.service = needsService
      }

      // Step 3: Start service if needed
      if (this.service) {
        const serviceStep = await this.startService()
        result.steps.push(serviceStep)

        if (!serviceStep.success) {
          result.error = `Failed to start service: ${serviceStep.error}`
          return result
        }
      }

      // Step 4: Run the actual tests
      const testStep = await this.runPluginTests()
      result.steps.push(testStep)
      result.output = testStep.output
      result.testResults = testStep.testResults

      if (!testStep.success) {
        result.error = `Tests failed: ${testStep.error}`
        return result
      }

      result.success = true
    } catch (error) {
      result.error = error.message
    } finally {
      // Cleanup services if needed
      if (this.service && this.cleanup) {
        const cleanupStep = await this.cleanupService()
        result.steps.push(cleanupStep)
      }

      // Cleanup APM test agent if needed
      if (this.testAgentStarted && this.cleanup) {
        const testAgentCleanupStep = await this.cleanupTestAgent()
        result.steps.push(testAgentCleanupStep)
      }

      result.duration = Date.now() - startTime
    }

    return result
  }

  async determineServiceNeeds () {
    // Check if plugin name suggests a service dependency
    const pluginLower = this.pluginId.toLowerCase()

    for (const [pattern, service] of Object.entries(SERVICE_DEPENDENCIES)) {
      if (pluginLower.includes(pattern)) {
        return service
      }
    }

    // Check if there's a docker-compose.yml mentioning this plugin
    try {
      const dockerComposePath = path.join(this.workspaceRoot, 'docker-compose.yml')
      const dockerComposeContent = await fs.readFile(dockerComposePath, 'utf8')

      for (const [pattern, service] of Object.entries(SERVICE_DEPENDENCIES)) {
        if (pluginLower.includes(pattern) && dockerComposeContent.includes(service)) {
          return service
        }
      }
    } catch (error) {
      // docker-compose.yml might not exist, that's fine
    }

    return null
  }

  async startTestAgent () {
    const step = {
      name: 'start-test-agent',
      command: `docker-compose up -d ${APM_TEST_AGENT_CONFIG.service}`,
      success: false,
      output: '',
      error: null,
      duration: 0
    }

    const startTime = Date.now()

    try {
      if (this.verbose) {
        console.log('🔬 Starting APM Test Agent...')
      }

      const output = await this.runCommand('docker-compose', ['up', '-d', APM_TEST_AGENT_CONFIG.service])
      step.output = output

      // Wait for test agent to be ready
      await this.waitForTestAgent()

      this.testAgentStarted = true
      step.success = true

      if (this.verbose) {
        console.log(`✅ APM Test Agent started successfully on port ${APM_TEST_AGENT_CONFIG.port}`)
      }
    } catch (error) {
      step.error = error.message
      if (this.verbose) {
        console.error('❌ Failed to start APM Test Agent:', error.message)
      }
    } finally {
      step.duration = Date.now() - startTime
    }

    return step
  }

  async waitForTestAgent () {
    const maxAttempts = 30
    const delay = 1000 // 1 second

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.verbose && attempt > 1) {
          console.log(`   Waiting for test agent... (${attempt}/${maxAttempts})`)
        }

        // Check if test agent is responsive
        const { spawn } = require('child_process')
        const curl = spawn('curl', ['-f', '-s', APM_TEST_AGENT_CONFIG.healthEndpoint], {
          stdio: 'pipe'
        })

        await new Promise((resolve, reject) => {
          curl.on('close', (code) => {
            if (code === 0) {
              resolve()
            } else {
              reject(new Error(`Health check failed with code ${code}`))
            }
          })
          curl.on('error', reject)
        })

        return // Success
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(`APM Test Agent failed to become ready after ${maxAttempts} attempts: ${error.message}`)
        }
        await this.sleep(delay)
      }
    }
  }

  async cleanupTestAgent () {
    const step = {
      name: 'cleanup-test-agent',
      command: `docker-compose stop ${APM_TEST_AGENT_CONFIG.service}`,
      success: false,
      output: '',
      error: null,
      duration: 0
    }

    const startTime = Date.now()

    try {
      if (this.verbose) {
        console.log('🧹 Cleaning up APM Test Agent...')
      }

      const output = await this.runCommand('docker-compose', ['stop', APM_TEST_AGENT_CONFIG.service])
      step.output = output
      step.success = true
      this.testAgentStarted = false

      if (this.verbose) {
        console.log('✅ APM Test Agent cleanup completed')
      }
    } catch (error) {
      step.error = error.message
      if (this.verbose) {
        console.error('❌ Test agent cleanup failed:', error.message)
      }
    } finally {
      step.duration = Date.now() - startTime
    }

    return step
  }

  async startService () {
    const step = {
      name: 'start-service',
      command: `docker-compose up -d ${this.service}`,
      success: false,
      output: '',
      error: null,
      duration: 0
    }

    const startTime = Date.now()

    try {
      if (this.verbose) {
        console.log(`🐳 Starting Docker service: ${this.service}`)
      }

      const output = await this.runCommand('docker-compose', ['up', '-d', this.service])
      step.output = output

      // Wait a bit for service to be ready
      await this.sleep(3000)

      // Verify service is running
      const psOutput = await this.runCommand('docker-compose', ['ps', this.service])
      if (!psOutput.includes('Up')) {
        throw new Error(`Service ${this.service} failed to start properly`)
      }

      step.success = true

      if (this.verbose) {
        console.log(`✅ Service ${this.service} started successfully`)
      }
    } catch (error) {
      step.error = error.message
      if (this.verbose) {
        console.error(`❌ Failed to start service ${this.service}:`, error.message)
      }
    } finally {
      step.duration = Date.now() - startTime
    }

    return step
  }

  async runPluginTests () {
    const step = {
      name: 'run-tests',
      command: `PLUGINS=${this.pluginId} yarn test:plugins:ci`,
      success: false,
      output: '',
      error: null,
      duration: 0,
      testResults: null
    }

    const startTime = Date.now()

    try {
      if (this.verbose) {
        console.log(`🧪 Running tests for plugin: ${this.pluginId}`)
      }

      const env = { ...process.env, PLUGINS: this.pluginId }
      const output = await this.runCommand('yarn', ['test:plugins:ci'], { env, timeout: this.timeout })

      step.output = output
      step.testResults = this.parseTestOutput(output)
      step.success = true

      if (this.verbose) {
        console.log(`✅ Tests completed for ${this.pluginId}`)
        if (step.testResults) {
          console.log(`   Tests: ${step.testResults.passed}/${step.testResults.total} passed`)
          if (step.testResults.failed > 0) {
            console.log(`   Failed: ${step.testResults.failed}`)
          }
        }
      }
    } catch (error) {
      step.error = error.message
      step.output = error.output || ''
      step.testResults = this.parseTestOutput(step.output)

      if (this.verbose) {
        console.error(`❌ Tests failed for ${this.pluginId}:`, error.message)
      }
    } finally {
      step.duration = Date.now() - startTime
    }

    return step
  }

  async cleanupService () {
    const step = {
      name: 'cleanup-service',
      command: `docker-compose down ${this.service}`,
      success: false,
      output: '',
      error: null,
      duration: 0
    }

    const startTime = Date.now()

    try {
      if (this.verbose) {
        console.log(`🧹 Cleaning up Docker service: ${this.service}`)
      }

      const output = await this.runCommand('docker-compose', ['down'])
      step.output = output
      step.success = true

      if (this.verbose) {
        console.log('✅ Service cleanup completed')
      }
    } catch (error) {
      step.error = error.message
      if (this.verbose) {
        console.error('❌ Cleanup failed:', error.message)
      }
    } finally {
      step.duration = Date.now() - startTime
    }

    return step
  }

  parseTestOutput (output) {
    if (!output) return null

    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      suites: [],
      failures: [],
      summary: ''
    }

    // Parse Jest/Mocha output patterns
    const lines = output.split('\n')

    for (const line of lines) {
      // Jest patterns
      if (line.includes('Tests:')) {
        const match = line.match(/Tests:\s*(\d+)\s*failed,\s*(\d+)\s*passed,\s*(\d+)\s*total/)
        if (match) {
          results.failed = parseInt(match[1])
          results.passed = parseInt(match[2])
          results.total = parseInt(match[3])
        }
      }

      // Mocha patterns
      if (line.includes('passing') && line.includes('failing')) {
        const passingMatch = line.match(/(\d+)\s+passing/)
        const failingMatch = line.match(/(\d+)\s+failing/)
        if (passingMatch) results.passed = parseInt(passingMatch[1])
        if (failingMatch) results.failed = parseInt(failingMatch[1])
        results.total = results.passed + results.failed
      }

      // Capture test failures
      if (line.includes('✗') || line.includes('×') || line.includes('FAIL')) {
        results.failures.push(line.trim())
      }
    }

    // Extract summary
    const summaryLines = lines.slice(-10).filter(line =>
      line.includes('Test Suites:') ||
      line.includes('Tests:') ||
      line.includes('passing') ||
      line.includes('failing')
    )
    results.summary = summaryLines.join('\n')

    return results
  }

  async runCommand (command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const { timeout = this.timeout, env = process.env } = options

      const child = spawn(command, args, {
        cwd: this.workspaceRoot,
        env,
        stdio: 'pipe'
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        const chunk = data.toString()
        stdout += chunk
        if (this.verbose) {
          process.stdout.write(chunk)
        }
      })

      child.stderr.on('data', (data) => {
        const chunk = data.toString()
        stderr += chunk
        if (this.verbose) {
          process.stderr.write(chunk)
        }
      })

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${timeout}ms`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timeoutId)

        const output = stdout + stderr

        if (code === 0) {
          resolve(output)
        } else {
          const error = new Error(`Command failed with exit code ${code}`)
          error.code = code
          error.output = output
          reject(error)
        }
      })

      child.on('error', (error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
    })
  }

  sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

module.exports = TestRunner
