import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, it } from 'mocha'
import sinon from 'sinon'

import { downloadArtifacts } from './download-artifacts.mjs'

describe('download-artifacts', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('prefers artifacts from the latest run attempt', async () => {
    const artifacts = [
      { id: 1, name: 'coverage-unit' },
      { id: 2, name: 'coverage-unit-retry-1' },
      { id: 3, name: 'coverage-unit-retry-2' },
      { id: 4, name: 'junit-unit' },
      { id: 5, name: 'junit-unit-retry-1' },
      { id: 6, name: 'junit-unit-retry-2' },
      { id: 7, name: 'unrelated' },
      { id: 8, name: 'coverage-latest-retry-1' },
      { id: 9, name: 'coverage-latest' },
    ]
    const octokit = {
      paginate: sinon.stub().resolves(artifacts),
      rest: { actions: { listWorkflowRunArtifacts: sinon.stub() } },
    }
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 500 })
    sinon.stub(console, 'error')

    const result = await downloadArtifacts(octokit, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      token: 'token',
      runs: [{ id: 42 }],
      retries: 0,
    })

    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/1/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/2/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/4/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/5/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/7/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/8/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/3/zip'), true)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/6/zip'), true)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/9/zip'), true)
    assert.deepEqual(result, { downloaded: 0, failed: 3 })
  })

  it('downloads original artifacts when no retry exists', async () => {
    const artifacts = [
      { id: 1, name: 'coverage-unit' },
      { id: 2, name: 'junit-unit' },
      { id: 3, name: 'unrelated' },
    ]
    const octokit = {
      paginate: sinon.stub().resolves(artifacts),
      rest: { actions: { listWorkflowRunArtifacts: sinon.stub() } },
    }
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 500 })
    sinon.stub(console, 'error')

    const result = await downloadArtifacts(octokit, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      token: 'token',
      runs: [{ id: 42 }],
      retries: 0,
    })

    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/1/zip'), true)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/2/zip'), true)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/3/zip'), false)
    assert.deepEqual(result, { downloaded: 0, failed: 2 })
  })

  it('recovers when a transient download failure clears', async () => {
    const originalCwd = process.cwd()
    const tempDir = mkdtempSync(join(tmpdir(), 'dd-trace-artifact-test-'))
    writeFileSync(join(tempDir, 'lcov.info'), 'TN:\n')
    execFileSync('zip', ['-q', 'artifact.zip', 'lcov.info'], { cwd: tempDir })
    const zip = readFileSync(join(tempDir, 'artifact.zip'))
    const artifacts = [{ id: 10, name: 'coverage-unit' }]
    const octokit = {
      paginate: sinon.stub().resolves(artifacts),
      rest: { actions: { listWorkflowRunArtifacts: sinon.stub() } },
    }
    const fetchStub = sinon.stub(globalThis, 'fetch')
    fetchStub.onFirstCall().resolves(new Response(null, {
      status: 503,
      headers: { 'retry-after': '0' },
    }))
    fetchStub.onSecondCall().resolves(new Response(zip))
    const logStub = sinon.stub(console, 'log')

    try {
      process.chdir(tempDir)
      const result = await downloadArtifacts(octokit, {
        owner: 'DataDog',
        repo: 'dd-trace-js',
        token: 'token',
        runs: [{ id: 42 }],
        delayMs: 10_000,
      })

      assert.equal(fetchStub.callCount, 2)
      assert.deepEqual(result, { downloaded: 1, failed: 0 })
      assert.match(logStub.firstCall.firstArg, /\[retry 1\/4\] coverage-unit from run 42: HTTP 503/)
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('returns the exact failure after exhausting all attempts', async () => {
    const artifacts = [{ id: 10, name: 'coverage-unit' }]
    const octokit = {
      paginate: sinon.stub().resolves(artifacts),
      rest: { actions: { listWorkflowRunArtifacts: sinon.stub() } },
    }
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({
      ok: false,
      status: 503,
      headers: new Headers({ 'retry-after': '0' }),
    })
    const errorStub = sinon.stub(console, 'error')

    const result = await downloadArtifacts(octokit, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      token: 'token',
      runs: [{ id: 42 }],
      delayMs: 0,
    })

    assert.equal(fetchStub.callCount, 5)
    assert.deepEqual(result, { downloaded: 0, failed: 1 })
    assert.equal(
      errorStub.calledWith(
        'Failed to download coverage-unit from run 42: HTTP 503'
      ),
      true
    )
  })
})
