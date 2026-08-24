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

  it('polls the workflow run returned by the dispatch request', async () => {
    process.env.GITHUB_TOKEN = 'token'
    process.env.TEST_ENVIRONMENT_REF_NAME = 'feature-branch'
    process.env.TEST_ENVIRONMENT_REF_TO_TEST = 'abc123'

    const responses = [
      {
        body: JSON.stringify({
          workflow_run_id: 12345,
          run_url: 'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345',
          html_url: 'https://github.com/DataDog/test-environment/actions/runs/12345',
        }),
        statusCode: 200,
      },
      {
        body: JSON.stringify({
          jobs: [{ conclusion: 'success', status: 'completed' }],
        }),
        statusCode: 200,
      },
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

    assert.strictEqual(requests.length, 2)
    assert.strictEqual(requests[0].url,
      'https://api.github.com/repos/DataDog/test-environment/actions/workflows/dd-trace-js-tests.yml/dispatches')
    assert.strictEqual(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10')
    assert.deepStrictEqual(JSON.parse(requests[0].body), {
      inputs: { sha: 'abc123' },
      ref: 'main',
    })
    assert.strictEqual(requests[1].url,
      'https://api.github.com/repos/DataDog/test-environment/actions/runs/12345/jobs')
  })
})

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
