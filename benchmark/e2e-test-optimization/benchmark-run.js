'use strict'

/* eslint-disable no-console */

const https = require('https')
const { setTimeout } = require('timers/promises')

const API_REPOSITORY_URL = 'https://api.github.com/repos/DataDog/test-environment'
const DISPATCH_WORKFLOW_URL = `${API_REPOSITORY_URL}/actions/workflows/dd-trace-js-tests.yml/dispatches`
const GET_WORKFLOWS_URL = `${API_REPOSITORY_URL}/actions/runs`

const POLL_INTERVAL_MS = 5000
const MAX_WORKFLOW_WAIT_MS = 30 * 60 * 1000
const MAX_WORKFLOW_POLLS = MAX_WORKFLOW_WAIT_MS / POLL_INTERVAL_MS
const RETRY_GRACE_PERIOD_MS = 60 * 1000
const RETRY_GRACE_PERIOD_POLLS = RETRY_GRACE_PERIOD_MS / POLL_INTERVAL_MS
const INITIAL_RUN_ATTEMPT = 1

const getResponsePreview = (body) => {
  return body.replace(/\s+/g, ' ').slice(0, 200)
}

const parseGitHubJsonResponse = ({ body, endpoint, res }) => {
  const statusCode = res.statusCode || 0
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `GitHub API ${endpoint} returned status ${statusCode}. Body preview: ${getResponsePreview(body)}`
    )
  }

  const contentType = String(res.headers['content-type'] || '')
  if (!contentType.includes('application/json')) {
    throw new Error(
      `GitHub API ${endpoint} returned unexpected content-type "${contentType}". Body preview: ${
        getResponsePreview(body)
      }`
    )
  }

  try {
    return JSON.parse(body)
  } catch (e) {
    throw new Error(
      `GitHub API ${endpoint} returned invalid JSON. Body preview: ${getResponsePreview(body)}`,
      { cause: e }
    )
  }
}

function getRefToTest () {
  if (!process.env.TEST_ENVIRONMENT_REF_TO_TEST) {
    throw new Error('TEST_ENVIRONMENT_REF_TO_TEST is required to trigger test-environment')
  }

  return process.env.TEST_ENVIRONMENT_REF_TO_TEST
}

function getRefName () {
  return process.env.TEST_ENVIRONMENT_REF_NAME || getRefToTest()
}

const getCommonHeaders = () => {
  return {
    'Content-Type': 'application/json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'user-agent': 'dd-trace benchmark tests',
  }
}

const triggerWorkflow = () => {
  console.log(`Commit SHA under test: ${getRefToTest()} in ${getRefName()}`)
  return new Promise((resolve, reject) => {
    let response = ''
    const body = JSON.stringify({
      ref: 'main',
      inputs: { sha: getRefToTest() },
    })
    const request = https.request(
      DISPATCH_WORKFLOW_URL,
      {
        method: 'POST',
        headers: getCommonHeaders(),
      }, (res) => {
        res.on('data', (chunk) => {
          response += chunk
        })
        res.on('end', () => {
          try {
            resolve(parseGitHubJsonResponse({
              body: response,
              endpoint: DISPATCH_WORKFLOW_URL,
              res,
            }))
          } catch (e) {
            reject(e)
          }
        })
      })
    request.on('error', (error) => {
      reject(error)
    })
    request.write(body)
    request.end()
  })
}

/**
 * Gets the latest state for a workflow run.
 *
 * @param {number} runId
 * @returns {Promise<{ conclusion: string, run_attempt: number, status: string }>}
 */
const getCurrentWorkflow = (runId) => {
  let body = ''
  return new Promise((resolve, reject) => {
    if (!runId) {
      reject(new Error('No workflow run id specified'))
      return
    }
    const endpoint = `${GET_WORKFLOWS_URL}/${runId}`
    const request = https.request(
      endpoint,
      {
        headers: getCommonHeaders(),
      },
      (res) => {
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve(parseGitHubJsonResponse({
              body,
              endpoint,
              res,
            }))
          } catch (e) {
            reject(e)
          }
        })
      })
    request.on('error', err => {
      reject(err)
    })
    request.end()
  })
}

/**
 * Waits for the current workflow attempt to finish.
 *
 * @param {number} runId
 * @param {string} workflowUrl
 * @param {number} workflowDeadline
 * @param {number} [minimumRunAttempt]
 * @returns {Promise<{ conclusion: string, run_attempt: number }>}
 */
async function waitForWorkflowCompletion (
  runId,
  workflowUrl,
  workflowDeadline,
  minimumRunAttempt = INITIAL_RUN_ATTEMPT
) {
  for (let poll = 0; poll < MAX_WORKFLOW_POLLS; poll++) {
    if (Date.now() > workflowDeadline) {
      break
    }

    let currentWorkflow
    try {
      currentWorkflow = await getCurrentWorkflow(runId)
    } catch (e) {
      console.error('Workflow check failed (%s). Retry in 5 seconds.', e.message)
    }

    if (currentWorkflow) {
      const { conclusion, run_attempt: runAttempt, status } = currentWorkflow
      if (runAttempt >= minimumRunAttempt && status === 'completed') {
        return { conclusion, run_attempt: runAttempt }
      }

      console.log(
        `Workflow ${workflowUrl} is not finished yet. [Poll ${poll + 1}/${MAX_WORKFLOW_POLLS}]`
      )
    }

    const waitMs = Math.min(POLL_INTERVAL_MS, workflowDeadline - Date.now())
    if (waitMs <= 0) {
      break
    }
    await setTimeout(waitMs)
  }

  throw new Error(
    `Timeout: Workflow did not finish within 30 minutes. Check ${workflowUrl} for more details.`
  )
}

/**
 * Waits for GitHub to create the single automatic retry allowed for a failed workflow.
 *
 * @param {number} runId
 * @param {number} failedRunAttempt
 * @param {number} workflowDeadline
 * @returns {Promise<number|undefined>}
 */
async function waitForWorkflowRetry (runId, failedRunAttempt, workflowDeadline) {
  const retryDeadline = Math.min(Date.now() + RETRY_GRACE_PERIOD_MS, workflowDeadline)
  for (let poll = 0; poll <= RETRY_GRACE_PERIOD_POLLS; poll++) {
    if (Date.now() > retryDeadline) {
      break
    }

    try {
      const { run_attempt: currentRunAttempt } = await getCurrentWorkflow(runId)
      if (currentRunAttempt > failedRunAttempt) {
        return currentRunAttempt
      }
    } catch (e) {
      console.error('Workflow retry check failed (%s). Retry in 5 seconds.', e.message)
    }
    const waitMs = Math.min(POLL_INTERVAL_MS, retryDeadline - Date.now())
    if (poll < RETRY_GRACE_PERIOD_POLLS && waitMs > 0) {
      await setTimeout(waitMs)
    }
  }

  return undefined
}

async function main () {
  // Trigger JS GHA
  console.log('Triggering Test Optimization test environment workflow.')
  const triggeredWorkflow = await triggerWorkflow()
  console.log('Triggered workflow:', triggeredWorkflow)

  const { workflow_run_id: runId } = triggeredWorkflow
  if (!runId) {
    throw new Error('Triggered workflow response did not include a run id')
  }

  const workflowUrl = `https://github.com/DataDog/test-environment/actions/runs/${runId}`
  console.log(`Workflow URL: ${workflowUrl}`)

  // Wait an initial 1 minute, because we're sure it won't finish earlier
  await setTimeout(60000)

  const workflowDeadline = Date.now() + MAX_WORKFLOW_WAIT_MS
  let currentWorkflow = await waitForWorkflowCompletion(runId, workflowUrl, workflowDeadline)
  if (currentWorkflow.conclusion !== 'success' && currentWorkflow.run_attempt === INITIAL_RUN_ATTEMPT) {
    console.log('Workflow attempt %d failed. Waiting up to 1 minute for an automatic retry.',
      currentWorkflow.run_attempt)
    const retryRunAttempt = await waitForWorkflowRetry(runId, currentWorkflow.run_attempt, workflowDeadline)
    if (retryRunAttempt !== undefined) {
      currentWorkflow = await waitForWorkflowCompletion(runId, workflowUrl, workflowDeadline, retryRunAttempt)
    }
  }

  if (currentWorkflow.conclusion === 'success') {
    console.log('Performance overhead test successful.')
  } else {
    const workflowAttemptUrl = `${workflowUrl}/attempts/${currentWorkflow.run_attempt}`
    throw new Error(`Performance overhead test failed.\n  Check ${workflowAttemptUrl} for more details.`)
  }
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
