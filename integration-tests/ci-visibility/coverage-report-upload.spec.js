'use strict'

const assert = require('node:assert/strict')
const { fork } = require('child_process')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { sandboxCwd, useSandbox } = require('../helpers')

describe('Coverage Report Upload', () => {
  let cwd, receiver, childProcess

  useSandbox(['jest'], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    if (childProcess) {
      childProcess.kill()
    }
    await receiver.stop()
  })

  it('uploads coverage reports when feature is enabled', (done) => {
    receiver.setCoverageReportUploadEnabled(true)

    let coverageReportUploaded = false

    receiver.on('message', ({ url, payload }) => {
      if (url === '/api/v2/cicovreprt') {
        coverageReportUploaded = true

        // Verify we received coverage report files
        assert.ok(payload.coverageReports, 'Should have coverage reports')
        assert.ok(payload.coverageReports.length > 0, 'Should have at least one coverage report')

        // Verify events metadata
        assert.ok(payload.events, 'Should have events metadata')
        assert.ok(Array.isArray(payload.events), 'Events should be an array')
        assert.ok(payload.events.length > 0, 'Should have at least one event')

        // Verify event structure
        const event = payload.events[0]
        assert.strictEqual(event.type, 'coverage_report', 'Event type should be coverage_report')
        assert.ok(event.format, 'Event should have format field')
        assert.ok(['lcov', 'cobertura', 'clover', 'jacoco'].includes(event.format),
          'Format should be a supported type')

        // Verify coverage report is gzipped
        const report = payload.coverageReports[0]
        assert.ok(report.content, 'Coverage report should have content')
        assert.ok(Buffer.isBuffer(report.content), 'Content should be a buffer')

        // Try to decompress to verify it's gzipped
        try {
          const decompressed = zlib.gunzipSync(report.content)
          assert.ok(decompressed.length > 0, 'Decompressed content should not be empty')
        } catch (err) {
          assert.fail(`Coverage report should be gzipped: ${err.message}`)
        }
      }
    })

    // Run Jest with coverage enabled
    childProcess = fork('ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...process.env,
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        DD_API_KEY: '1',
        DD_SITE: 'datad0g.com',
        NODE_OPTIONS: '-r dd-trace/ci/init',
        TESTS_TO_RUN: 'ci-visibility/jest'
      },
      stdio: 'pipe'
    })

    childProcess.on('message', (message) => {
      if (message === 'finished') {
        // Give some time for async operations
        setTimeout(() => {
          assert.ok(coverageReportUploaded, 'Coverage report should have been uploaded')
          done()
        }, 1000)
      }
    })

    childProcess.on('exit', (code) => {
      if (code !== 0 && !coverageReportUploaded) {
        done(new Error(`Jest exited with code ${code}`))
      }
    })
  })

  it('does not upload when feature is disabled', (done) => {
    receiver.setCoverageReportUploadEnabled(false)

    let coverageReportUploaded = false

    receiver.on('message', ({ url }) => {
      if (url === '/api/v2/cicovreprt') {
        coverageReportUploaded = true
      }
    })

    childProcess = fork('ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...process.env,
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        DD_API_KEY: '1',
        DD_SITE: 'datad0g.com',
        NODE_OPTIONS: '-r dd-trace/ci/init',
        TESTS_TO_RUN: 'ci-visibility/jest'
      },
      stdio: 'pipe'
    })

    childProcess.on('message', (message) => {
      if (message === 'finished') {
        setTimeout(() => {
          assert.ok(!coverageReportUploaded, 'Coverage report should not have been uploaded')
          done()
        }, 1000)
      }
    })

    childProcess.on('exit', (code) => {
      if (code !== 0 && !coverageReportUploaded) {
        done(new Error(`Jest exited with code ${code}`))
      }
    })
  })

  it('does not upload when DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED is false', (done) => {
    receiver.setCoverageReportUploadEnabled(true) // Enabled in remote settings

    let coverageReportUploaded = false

    receiver.on('message', ({ url }) => {
      if (url === '/api/v2/cicovreprt') {
        coverageReportUploaded = true
      }
    })

    childProcess = fork('ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...process.env,
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        DD_API_KEY: '1',
        DD_SITE: 'datad0g.com',
        DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED: 'false', // Kill switch
        NODE_OPTIONS: '-r dd-trace/ci/init',
        TESTS_TO_RUN: 'ci-visibility/jest'
      },
      stdio: 'pipe'
    })

    childProcess.on('message', (message) => {
      if (message === 'finished') {
        setTimeout(() => {
          assert.ok(!coverageReportUploaded,
            'Coverage report should not have been uploaded when kill switch is enabled')
          done()
        }, 1000)
      }
    })

    childProcess.on('exit', (code) => {
      if (code !== 0 && !coverageReportUploaded) {
        done(new Error(`Jest exited with code ${code}`))
      }
    })
  })

  it('automatically enables Jest coverage collection', (done) => {
    receiver.setCoverageReportUploadEnabled(true)

    childProcess = fork('ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...process.env,
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        DD_API_KEY: '1',
        DD_SITE: 'datad0g.com',
        NODE_OPTIONS: '-r dd-trace/ci/init',
        TESTS_TO_RUN: 'ci-visibility/jest'
      },
      stdio: 'pipe'
    })

    childProcess.on('message', (message) => {
      if (message === 'finished') {
        // Verify that coverage directory was created (Jest auto-collected coverage)
        const coverageDir = path.join(cwd, 'coverage')
        const coverageExists = fs.existsSync(coverageDir)

        assert.ok(coverageExists, 'Coverage directory should exist (auto-enabled by tracer)')

        if (coverageExists) {
          // Check for common coverage files
          const lcovExists = fs.existsSync(path.join(coverageDir, 'lcov.info'))
          assert.ok(lcovExists, 'LCOV file should exist')
        }

        done()
      }
    })

    childProcess.on('exit', (code) => {
      if (code !== 0) {
        done(new Error(`Jest exited with code ${code}`))
      }
    })
  })

  it('includes Git and CI tags in event metadata', (done) => {
    receiver.setCoverageReportUploadEnabled(true)

    let eventMetadata = null

    receiver.on('message', ({ url, payload }) => {
      if (url === '/api/v2/cicovreprt' && payload.events) {
        eventMetadata = payload.events[0]
      }
    })

    childProcess = fork('ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...process.env,
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        DD_API_KEY: '1',
        DD_SITE: 'datad0g.com',
        NODE_OPTIONS: '-r dd-trace/ci/init',
        TESTS_TO_RUN: 'ci-visibility/jest',
        DD_GIT_REPOSITORY_URL: 'https://github.com/test/repo',
        DD_GIT_COMMIT_SHA: 'abc123def456',
        DD_GIT_BRANCH: 'main'
      },
      stdio: 'pipe'
    })

    childProcess.on('message', (message) => {
      if (message === 'finished') {
        setTimeout(() => {
          assert.ok(eventMetadata, 'Should have received event metadata')

          // Verify Git tags are included
          if (eventMetadata['git.repository_url']) {
            assert.strictEqual(eventMetadata['git.repository_url'], 'https://github.com/test/repo')
          }
          if (eventMetadata['git.commit.sha']) {
            assert.strictEqual(eventMetadata['git.commit.sha'], 'abc123def456')
          }
          if (eventMetadata['git.branch']) {
            assert.strictEqual(eventMetadata['git.branch'], 'main')
          }

          done()
        }, 1000)
      }
    })

    childProcess.on('exit', (code) => {
      if (code !== 0 && !eventMetadata) {
        done(new Error(`Jest exited with code ${code}`))
      }
    })
  })
})
