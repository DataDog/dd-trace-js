'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

/**
 * @typedef {object} ResponseData
 * @property {string} body
 * @property {number} statusCode
 */

/**
 * @typedef {object} RequestRecord
 * @property {string} body
 * @property {{ headers: Record<string, string> }} options
 * @property {string} url
 */

/**
 * @callback RequestStub
 * @param {string} url
 * @param {{ headers: Record<string, string> }} options
 * @param {(response: EventEmitter & {
 *   headers: Record<string, string>,
 *   statusCode: number
 * }) => void} callback
 * @returns {EventEmitter & {
 *   end: () => void,
 *   write: (chunk: string) => void
 * }}
 */

describe('test optimization end-to-end benchmark runner', () => {
  const originalEnvironment = {
    githubToken: process.env.GITHUB_TOKEN,
    refName: process.env.TEST_ENVIRONMENT_REF_NAME,
    refToTest: process.env.TEST_ENVIRONMENT_REF_TO_TEST,
  }
  const originalExitCode = process.exitCode

  afterEach(() => {
    restoreEnvironmentVariable('GITHUB_TOKEN', originalEnvironment.githubToken)
    restoreEnvironmentVariable('TEST_ENVIRONMENT_REF_NAME', originalEnvironment.refName)
    restoreEnvironmentVariable('TEST_ENVIRONMENT_REF_TO_TEST', originalEnvironment.refToTest)
    process.exitCode = originalExitCode
    sinon.restore()
  })

  it('polls the workflow run returned by the dispatch request until it succeeds', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_NAME = 'feature-branch'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const responses = [
      createDispatchResponse(),
      createWorkflowResponse(undefined, 1, 'in_progress'),
      createWorkflowResponse('success', 1),
    ]
    const requests = []
    const completion = waitForSuccessfulCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    await completion

    assert.strictEqual(requests.length, 3)
    assert.strictEqual(requests[0].url,
      'https://api.github.com/repos/DataDog/test-environment/actions/workflows/dd-trace-js-tests.yml/dispatches')
    assert.strictEqual(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10')
    assert.deepStrictEqual(JSON.parse(requests[0].body), {
      inputs: { sha: 'abc123' },
      ref: 'main',
    })
    assert.strictEqual(requests[1].url,
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345')
    assert.strictEqual(requests[2].url,
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345')
  })

  it('accepts a successful automatic retry after the first attempt fails', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const responses = [
      createDispatchResponse(),
      createWorkflowResponse('failure', 1),
      createWorkflowResponse(undefined, 2, 'in_progress'),
      createWorkflowResponse('failure', 1),
      createWorkflowResponse('success', 2),
    ]
    const requests = []
    const completion = waitForSuccessfulCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    await completion

    assert.strictEqual(requests.length, 5)
    assert.deepStrictEqual(requests.slice(1).map(({ url }) => url), [
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345',
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345',
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345',
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345',
    ])
  })

  it('reports a failed retry using the retry-specific URL', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const responses = [
      createDispatchResponse(),
      createWorkflowResponse('failure', 1),
      createWorkflowResponse(undefined, 2, 'in_progress'),
      createWorkflowResponse('failure', 2),
    ]
    const requests = []
    const completion = waitForFailedCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    const error = await completion

    assert.strictEqual(error.message,
      'Performance overhead test failed.\n' +
      '  Check https://github.com/DataDog/test-environment/actions/runs/12345/attempts/2 for more details.')
    assert.strictEqual(requests.length, 4)
  })

  it('does not wait for another retry when the second attempt already failed', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const responses = [
      createDispatchResponse(),
      createWorkflowResponse('failure', 2),
    ]
    const requests = []
    const completion = waitForFailedCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    const error = await completion

    assert.strictEqual(error.message,
      'Performance overhead test failed.\n' +
      '  Check https://github.com/DataDog/test-environment/actions/runs/12345/attempts/2 for more details.')
    assert.strictEqual(requests.length, 2)
  })

  it('accepts a retry that starts at the end of the grace period', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const failedAttemptResponse = createWorkflowResponse('failure', 1)
    const responses = [
      createDispatchResponse(),
      failedAttemptResponse,
      ...Array.from({ length: 12 }, () => failedAttemptResponse),
      createWorkflowResponse(undefined, 2, 'in_progress'),
      createWorkflowResponse('success', 2),
    ]
    const requests = []
    const completion = waitForSuccessfulCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    await completion

    assert.strictEqual(requests.length, 16)
  })

  it('reports the first failure when no retry starts within the grace period', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const failedAttemptResponse = createWorkflowResponse('failure', 1)
    const responses = [
      createDispatchResponse(),
      failedAttemptResponse,
      ...Array.from({ length: 13 }, () => failedAttemptResponse),
    ]
    const requests = []
    const completion = waitForFailedCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    const error = await completion

    assert.strictEqual(error.message,
      'Performance overhead test failed.\n' +
      '  Check https://github.com/DataDog/test-environment/actions/runs/12345/attempts/1 for more details.')
    assert.strictEqual(requests.length, 15)
  })

  it('uses the original workflow deadline while waiting for a retry', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const workflowTimeoutMs = 30 * 60 * 1000
    sinon.stub(Date, 'now')
      .onCall(0).returns(0)
      .onCall(1).returns(0)
      .onCall(2).returns(workflowTimeoutMs - 1000)
      .onCall(3).returns(workflowTimeoutMs - 1000)
      .onCall(4).returns(workflowTimeoutMs + 1)

    const responses = [
      createDispatchResponse(),
      createWorkflowResponse('failure', 1),
      createWorkflowResponse(undefined, 2, 'in_progress'),
    ]
    const requests = []
    const completion = waitForFailedCompletion()

    proxyquire('./benchmark-run', {
      https: {
        request: createRequestStub(responses, requests),
      },
      'timers/promises': {
        setTimeout: () => Promise.resolve(),
      },
    })

    const error = await completion

    assert.strictEqual(error.message,
      'Timeout: Workflow did not finish within 30 minutes. ' +
      'Check https://github.com/DataDog/test-environment/actions/runs/12345 for more details.')
    assert.strictEqual(requests.length, 3)
  })
})

/**
 * @returns {ResponseData}
 */
function createDispatchResponse () {
  return {
    body: JSON.stringify({
      workflow_run_id: 12345,
    }),
    statusCode: 200,
  }
}

/**
 * @param {string|undefined} conclusion
 * @param {number} runAttempt
 * @param {string} [status]
 * @returns {ResponseData}
 */
function createWorkflowResponse (conclusion, runAttempt, status = 'completed') {
  return {
    body: JSON.stringify({
      conclusion,
      run_attempt: runAttempt,
      status,
    }),
    statusCode: 200,
  }
}

/**
 * @param {ResponseData[]} responses
 * @param {RequestRecord[]} requests
 * @returns {RequestStub}
 */
function createRequestStub (responses, requests) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    let body = ''

    request.write = chunk => {
      body += chunk
    }
    request.end = () => {
      requests.push({ body, options, url })
      const responseData = responses.shift()
      const response = new EventEmitter()
      response.headers = { 'content-type': 'application/json; charset=utf-8' }
      response.statusCode = responseData.statusCode
      callback(response)
      process.nextTick(() => {
        response.emit('data', responseData.body)
        response.emit('end')
      })
    }
    return request
  }
}

/**
 * @returns {Promise<void>}
 */
function waitForSuccessfulCompletion () {
  return new Promise((resolve, reject) => {
    sinon.stub(console, 'log').callsFake(message => {
      if (message === 'Performance overhead test successful.') {
        resolve()
      }
    })
    sinon.stub(console, 'error').callsFake(error => {
      reject(error)
    })
  })
}

/**
 * @returns {Promise<Error>}
 */
function waitForFailedCompletion () {
  return new Promise((resolve) => {
    sinon.stub(console, 'log')
    sinon.stub(console, 'error').callsFake(error => {
      if (error instanceof Error) {
        resolve(error)
      }
    })
  })
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @returns {void}
 */
function restoreEnvironmentVariable (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
