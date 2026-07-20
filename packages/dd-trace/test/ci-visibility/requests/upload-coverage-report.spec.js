'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { after, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('ci-visibility/requests/upload-coverage-report', () => {
  let filePath
  let requestStub
  let tmpDir
  let uploadCoverageReport

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-coverage-report-'))
    filePath = join(tmpDir, 'coverage.xml')
    writeFileSync(filePath, '<coverage />')
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    requestStub = sinon.stub()
    const { uploadCoverageReport: upload } = proxyquire(
      '../../../src/ci-visibility/requests/upload-coverage-report',
      {
        '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
        '../../exporters/common/request': requestStub,
      }
    )
    uploadCoverageReport = upload
  })

  function uploadAndReadEvent (flags) {
    return new Promise((resolve, reject) => {
      requestStub.callsFake((form, _options, callback) => {
        const chunks = []
        form.on('data', chunk => chunks.push(Buffer.from(chunk)))
        form.on('error', reject)
        form.on('end', () => {
          const body = Buffer.concat(chunks).toString()
          const eventPartStart = body.indexOf('name="event"')
          const eventContentStart = body.indexOf('\r\n\r\n', eventPartStart) + 4
          const eventContentEnd = body.indexOf('\r\n', eventContentStart)
          const eventPayload = JSON.parse(body.slice(eventContentStart, eventContentEnd))
          callback(null, 'ok', 200)
          resolve(eventPayload)
        })
      })

      uploadCoverageReport({
        filePath,
        flags,
        format: 'cobertura',
        testEnvironmentMetadata: {
          'ci.pipeline.id': '1234',
          'git.commit.sha': 'abc123',
        },
        url: new URL('http://localhost:8126'),
      }, (error) => {
        if (error) {
          reject(error)
        }
      })
    })
  }

  it('serializes coverage report flags under the exact report.flags key', async () => {
    const eventPayload = await uploadAndReadEvent(['type:unit-tests', 'jvm-21', 'type:unit-tests'])

    assert.deepStrictEqual(eventPayload, {
      type: 'coverage_report',
      format: 'cobertura',
      'ci.pipeline.id': '1234',
      'git.commit.sha': 'abc123',
      'report.flags': ['type:unit-tests', 'jvm-21', 'type:unit-tests'],
    })
  })

  for (const [name, flags] of [['undefined', undefined], ['empty', []]]) {
    it(`omits report.flags for an ${name} list`, async () => {
      const eventPayload = await uploadAndReadEvent(flags)

      assert.deepStrictEqual(eventPayload, {
        type: 'coverage_report',
        format: 'cobertura',
        'ci.pipeline.id': '1234',
        'git.commit.sha': 'abc123',
      })
    })
  }
})
