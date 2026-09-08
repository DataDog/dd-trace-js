import assert from 'node:assert/strict'

import { afterEach, describe, it } from 'mocha'
import sinon from 'sinon'

import { downloadArtifacts } from './download-artifacts.mjs'

describe('download-artifacts', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('prefers retry artifacts when a failed original becomes visible', async () => {
    const artifacts = [
      { id: 1, name: 'coverage-unit' },
      { id: 2, name: 'coverage-unit-retry' },
      { id: 4, name: 'junit-unit-retry' },
      { id: 3, name: 'junit-unit' },
      { id: 5, name: 'unrelated' },
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
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/3/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/5/zip'), false)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/2/zip'), true)
    assert.equal(fetchStub.calledWith('https://api.github.com/repos/DataDog/dd-trace-js/actions/artifacts/4/zip'), true)
    assert.deepEqual(result, { downloaded: 0, failed: 2 })
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
})
