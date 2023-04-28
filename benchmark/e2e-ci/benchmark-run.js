'use strict'

/* eslint-disable no-console */

const https = require('https')

const API_REPOSITORY_URL = 'https://api.github.com/repos/DataDog/test-environment'
const DISPATCH_WORKFLOW_URL = `${API_REPOSITORY_URL}/actions/workflows/dd-trace-js-tests.yml/dispatches`
const GET_WORKFLOWS_URL = `${API_REPOSITORY_URL}/actions/runs`

function getBranchUnderTest () {
  /**
   * GITHUB_HEAD_REF is only set for `pull_request` events
   * GITHUB_REF_NAME is used for `push` events
   * More info in: https://docs.github.com/en/actions/learn-github-actions/environment-variables
   */
  return process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME
}

const getCommonHeaders = () => {
  return {
    'Content-Type': 'application/json',
    'authorization': `Bearer ${process.env.ROBOT_CI_GITHUB_PERSONAL_ACCESS_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'user-agent': 'dd-trace benchmark tests'
  }
}

const triggerWorkflow = () => {
  console.log(`Branch under test: ${getBranchUnderTest()}`)
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line
    let response = ''
    const body = JSON.stringify({
      ref: 'main',
      inputs: { branch: getBranchUnderTest() }
    })
    const request = https.request(
      DISPATCH_WORKFLOW_URL,
      {
        method: 'POST',
        headers: getCommonHeaders()
      }, (res) => {
        res.on('data', (chunk) => {
          response += chunk
        })
        res.on('end', () => {
          resolve(res.statusCode)
        })
      })
    request.on('error', (error) => {
      reject(error)
    })
    request.write(body)
    request.end()
  })
}

const getWorkflowRunsInProgress = () => {
  return new Promise((resolve, reject) => {
    let response = ''
    const request = https.request(
      `${GET_WORKFLOWS_URL}?event=workflow_dispatch`,
      {
        headers: getCommonHeaders()
      },
      (res) => {
        res.on('data', (chunk) => {
          response += chunk
        })
        res.on('end', () => {
          resolve(JSON.parse(response))
        })
      })
    request.on('error', err => {
      reject(err)
    })
    request.end()
  })
}

const getCurrentWorkflowJobs = (runId) => {
  let body = ''
  return new Promise((resolve, reject) => {
    if (!runId) {
      reject(new Error('No job run id specified'))
      return
    }
    const request = https.request(
      `${GET_WORKFLOWS_URL}/${runId}/jobs`,
      {
        headers: getCommonHeaders()
      },
      (res) => {
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve(JSON.parse(body))
        })
      })
    request.on('error', err => {
      reject(err)
    })
    request.end()
  })
}

const wait = (timeToWaitMs) => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, timeToWaitMs)
  })
}

async function main () {
  // Trigger JS GHA
  console.log('Triggering CI Visibility test environment workflow.')
  const httpResponseCode = await triggerWorkflow()
  console.log('GitHub API response code:', httpResponseCode)

  if (httpResponseCode !== 204) {
    throw new Error('Could not trigger workflow')
  }

  // Give some time for GH to process the request
  await wait(15000)

  // Get the run ID from the workflow we just triggered
  const workflowsInProgress = await getWorkflowRunsInProgress()
  const { total_count: numWorkflows, workflow_runs: workflows } = workflowsInProgress
  if (numWorkflows === 0) {
    throw new Error('Could not find the triggered workflow')
  }
  // Pick the first one (most recently triggered one)
  const [triggeredWorkflow] = workflows

  console.log('Triggered workflow:', triggeredWorkflow)

  const { id: runId } = triggeredWorkflow || {}

  console.log(`Workflow URL: https://github.com/DataDog/test-environment/actions/runs/${runId}`)

  // Wait an initial 1 minute, because we're sure it won't finish earlier
  await wait(60000)

  // Poll every 5 seconds until we have a finished status
  await new Promise((resolve, reject) => {
    const intervalId = setInterval(async () => {
      const currentWorkflow = await getCurrentWorkflowJobs(runId)
      const { jobs } = currentWorkflow
      const hasAnyJobFailed = jobs.some(({ status, conclusion }) => status === 'completed' && conclusion !== 'success')
      const hasEveryJobPassed = jobs.every(
        ({ status, conclusion }) => status === 'completed' && conclusion === 'success'
      )
      if (hasAnyJobFailed) {
        reject(new Error(`Performance overhead test failed.
Check https://github.com/DataDog/test-environment/actions/runs/${runId} for more details.`))
        clearInterval(intervalId)
      } else if (hasEveryJobPassed) {
        console.log('Performance overhead test successful.')
        resolve()
        clearInterval(intervalId)
      } else {
        console.log(`Workflow https://github.com/DataDog/test-environment/actions/runs/${runId} is not finished yet.`)
      }
    }, 5000)
  })
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
