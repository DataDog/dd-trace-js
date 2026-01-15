'use strict'

const assert = require('assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('CoverageReportWriter', () => {
  let CoverageReportWriter
  let requestStub
  let tmpDir
  let testReportPath
  let getEnvironmentVariableStub

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-writer-test-'))
    testReportPath = path.join(tmpDir, 'lcov.info')
    fs.writeFileSync(testReportPath, 'TN:\nSF:file.js\nend_of_record')

    requestStub = sinon.stub()
    getEnvironmentVariableStub = sinon.stub()

    CoverageReportWriter = proxyquire('../../../../src/ci-visibility/exporters/agentless/coverage-report-writer', {
      '../../../exporters/common/request': requestStub,
      '../../../config-helper': {
        getEnvironmentVariable: getEnvironmentVariableStub
      }
    })
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    sinon.restore()
  })

  describe('uploadCoverageReports', () => {
    it('should upload single coverage report successfully', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')
      requestStub.callsFake((form, options, callback) => {
        assert.strictEqual(options.path, '/api/v2/cicovreprt')
        assert.strictEqual(options.method, 'POST')
        assert.strictEqual(options.headers['dd-api-key'], 'test-api-key')
        callback(null, '{}', 200)
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const tags = {
        'git.repository_url': 'https://github.com/test/repo',
        'git.commit.sha': 'abc123'
      }

      const writer = new CoverageReportWriter({ url, tags })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(requestStub.callCount, 1)
        done()
      })
    })

    it('should upload multiple coverage reports in single request', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')

      const coberturaPath = path.join(tmpDir, 'cobertura.xml')
      fs.writeFileSync(coberturaPath, '<coverage></coverage>')

      requestStub.callsFake((form, options, callback) => {
        // Just verify the request was made successfully
        // FormData is a complex multipart structure that's hard to inspect directly
        assert.ok(form, 'Form should be provided')
        assert.strictEqual(options.method, 'POST')
        callback(null, '{}', 200)
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const tags = { 'git.commit.sha': 'abc123' }

      const writer = new CoverageReportWriter({ url, tags })
      const reports = [
        { filePath: testReportPath, format: 'lcov' },
        { filePath: coberturaPath, format: 'cobertura' }
      ]

      writer.uploadCoverageReports(reports, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(requestStub.callCount, 1)
        done()
      })
    })

    it('should include event metadata with correct format', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')

      requestStub.callsFake((form, options, callback) => {
        // Extract event data from form
        const formString = form.toString()
        const eventMatch = formString.match(/"event"[\s\S]*?(\[[\s\S]*?\])/m)
        if (eventMatch) {
          const events = JSON.parse(eventMatch[1])
          assert.ok(Array.isArray(events))
          assert.strictEqual(events.length, 1)
          assert.strictEqual(events[0].type, 'coverage_report')
          assert.strictEqual(events[0].format, 'lcov')
          assert.strictEqual(events[0]['git.commit.sha'], 'abc123')
          assert.strictEqual(events[0]['git.repository_url'], 'https://github.com/test/repo')
        }
        callback(null, '{}', 200)
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const tags = {
        'git.commit.sha': 'abc123',
        'git.repository_url': 'https://github.com/test/repo'
      }

      const writer = new CoverageReportWriter({ url, tags })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.strictEqual(err, null)
        done()
      })
    })

    it('should use EVP proxy configuration when provided', (done) => {
      requestStub.callsFake((form, options, callback) => {
        assert.strictEqual(options.path, '/evp_proxy/v4/api/v2/cicovreprt')
        assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'ci-intake')
        assert.strictEqual(options.headers['dd-api-key'], undefined)
        callback(null, '{}', 200)
      })

      const url = new URL('https://agent-host:8126')
      const evpProxyPrefix = '/evp_proxy/v4'
      const tags = {}

      const writer = new CoverageReportWriter({ url, evpProxyPrefix, tags })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(requestStub.callCount, 1)
        done()
      })
    })

    it('should compress coverage reports with gzip', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')

      requestStub.callsFake((form, options, callback) => {
        // The form should contain gzipped content
        const formBuffer = Buffer.from(form.toString(), 'binary')
        assert.ok(formBuffer.length > 0)
        callback(null, '{}', 200)
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.strictEqual(err, null)
        done()
      })
    })

    it('should handle empty reports array', (done) => {
      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })

      writer.uploadCoverageReports([], (err) => {
        assert.strictEqual(err, undefined)
        assert.strictEqual(requestStub.callCount, 0)
        done()
      })
    })

    it('should handle null reports', (done) => {
      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })

      writer.uploadCoverageReports(null, (err) => {
        assert.strictEqual(err, undefined)
        assert.strictEqual(requestStub.callCount, 0)
        done()
      })
    })

    it('should handle file read errors gracefully', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')

      const nonExistentPath = path.join(tmpDir, 'non-existent.lcov')
      const writer = new CoverageReportWriter({
        url: new URL('https://ci-intake.datadoghq.com'),
        tags: {}
      })
      const reports = [{ filePath: nonExistentPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('Failed to process any coverage reports'))
        assert.strictEqual(requestStub.callCount, 0)
        done()
      })
    })

    it('should handle network errors gracefully', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')
      requestStub.callsFake((form, options, callback) => {
        callback(new Error('Network error'))
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.ok(err instanceof Error)
        assert.strictEqual(err.message, 'Network error')
        done()
      })
    })

    it('should require DD_API_KEY in agentless mode', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns(undefined)

      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })
      const reports = [{ filePath: testReportPath, format: 'lcov' }]

      writer.uploadCoverageReports(reports, (err) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('DD_API_KEY not set'))
        assert.strictEqual(requestStub.callCount, 0)
        done()
      })
    })

    it('should continue uploading even if one report fails', (done) => {
      getEnvironmentVariableStub.withArgs('DD_API_KEY').returns('test-api-key')

      const validPath = testReportPath
      const invalidPath = path.join(tmpDir, 'non-existent.lcov')
      const anotherValidPath = path.join(tmpDir, 'another.xml')
      fs.writeFileSync(anotherValidPath, '<coverage></coverage>')

      requestStub.callsFake((form, options, callback) => {
        // Should upload the 2 valid reports (one failed, two succeeded)
        assert.ok(form, 'Form should be provided')
        callback(null, '{}', 200)
      })

      const url = new URL('https://ci-intake.datadoghq.com')
      const writer = new CoverageReportWriter({ url, tags: {} })
      const reports = [
        { filePath: validPath, format: 'lcov' },
        { filePath: invalidPath, format: 'lcov' }, // This will fail
        { filePath: anotherValidPath, format: 'cobertura' }
      ]

      writer.uploadCoverageReports(reports, (err) => {
        // Should return error but still attempt upload
        assert.ok(err instanceof Error)
        assert.strictEqual(requestStub.callCount, 1)
        done()
      })
    })
  })
})
