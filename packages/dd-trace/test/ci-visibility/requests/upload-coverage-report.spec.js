'use strict'

const assert = require('node:assert/strict')
const {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('ci-visibility/requests/upload-coverage-report', () => {
  let filePath
  let requestStub
  let tmpDir
  let uploadCoverageReport

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-coverage-report-'))
    filePath = join(tmpDir, 'coverage.xml')
    writeFileSync(filePath, '<coverage />')

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

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {string[]|undefined} flags
   * @returns {Promise<Record<string, string|string[]>>}
   */
  function uploadAndReadEvent (flags) {
    const fileStats = lstatSync(filePath, { bigint: true })
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
        fileDevice: fileStats.dev,
        fileInode: fileStats.ino,
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

  /**
   * @param {import('node:fs').BigIntStats} fileStats
   * @returns {Promise<void>}
   */
  function uploadAndWait (fileStats) {
    const uploadCoverageReportAsync = promisify(uploadCoverageReport)
    return uploadCoverageReportAsync({
      filePath,
      fileDevice: fileStats.dev,
      fileInode: fileStats.ino,
      format: 'cobertura',
      testEnvironmentMetadata: {},
      url: new URL('http://localhost:8126'),
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

  it('rejects a report replaced with a different regular file after discovery', async () => {
    const fileStats = lstatSync(filePath, { bigint: true })
    renameSync(filePath, join(tmpDir, 'discovered-coverage.xml'))
    writeFileSync(filePath, '<replacement />')
    requestStub.yields(null, 'ok', 200)

    await assert.rejects(uploadAndWait(fileStats), {
      message: /coverage report changed after discovery/i,
    })
    sinon.assert.notCalled(requestStub)
  })

  it('distinguishes adjacent file identities above Number.MAX_SAFE_INTEGER', async () => {
    const discoveredFileInode = 9_007_199_254_740_992n
    const replacementFileInode = 9_007_199_254_740_993n
    const fstatSync = sinon.stub().returns({
      dev: 1n,
      ino: replacementFileInode,
      isFile: () => true,
    })
    const { uploadCoverageReport: upload } = proxyquire(
      '../../../src/ci-visibility/requests/upload-coverage-report',
      {
        'node:fs': { fstatSync },
        '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
        '../../exporters/common/request': requestStub,
      }
    )

    assert.strictEqual(Number(discoveredFileInode), Number(replacementFileInode))
    const uploadAsync = promisify(upload)
    await assert.rejects(uploadAsync({
      filePath,
      fileDevice: 1n,
      fileInode: discoveredFileInode,
      format: 'cobertura',
      testEnvironmentMetadata: {},
      url: new URL('http://localhost:8126'),
    }), {
      message: /coverage report changed after discovery/i,
    })
    sinon.assert.notCalled(requestStub)
  })

  it('uploads reports when O_NOFOLLOW is unavailable', async () => {
    const fileStats = lstatSync(filePath, { bigint: true })
    const { uploadCoverageReport: upload } = proxyquire(
      '../../../src/ci-visibility/requests/upload-coverage-report',
      {
        'node:fs': {
          constants: {
            O_NONBLOCK: constants.O_NONBLOCK,
            O_RDONLY: constants.O_RDONLY,
          },
        },
        '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
        '../../exporters/common/request': requestStub,
      }
    )
    requestStub.yields(null, 'ok', 200)

    const uploadAsync = promisify(upload)
    await uploadAsync({
      filePath,
      fileDevice: fileStats.dev,
      fileInode: fileStats.ino,
      format: 'cobertura',
      testEnvironmentMetadata: {},
      url: new URL('http://localhost:8126'),
    })

    sinon.assert.calledOnce(requestStub)
  })

  it('rejects a report replaced with a directory after discovery', async () => {
    const fileStats = lstatSync(filePath, { bigint: true })
    rmSync(filePath)
    mkdirSync(filePath)
    requestStub.yields(null, 'ok', 200)

    await assert.rejects(uploadAndWait(fileStats), {
      message: /failed to read coverage report/i,
    })
    sinon.assert.notCalled(requestStub)
  })

  it('rejects a report replaced with a symlink after discovery', async function () {
    if (process.platform === 'win32') this.skip()

    const fileStats = lstatSync(filePath, { bigint: true })
    const discoveredPath = join(tmpDir, 'discovered-coverage.xml')
    renameSync(filePath, discoveredPath)
    symlinkSync(discoveredPath, filePath)
    requestStub.yields(null, 'ok', 200)

    await assert.rejects(uploadAndWait(fileStats), {
      message: /failed to read coverage report/i,
    })
    sinon.assert.notCalled(requestStub)
  })
})
