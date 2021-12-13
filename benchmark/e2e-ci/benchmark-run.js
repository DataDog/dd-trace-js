'use strict'

/* eslint-disable no-console */

const https = require('https')

const API_REPOSITORY_URL = 'https://api.github.com/repos/DataDog/test-environment'
const DISPATCH_WORKFLOW_URL = `${API_REPOSITORY_URL}/actions/workflows/dd-trace-js-tests.yml/dispatches`
const GET_WORKFLOWS_URL = `${API_REPOSITORY_URL}/actions/runs`

const getCommonHeaders = () => {
  return {
    'Content-Type': 'application/json',
    'authorization': `Bearer ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'user-agent': 'dd-trace benchmark tests'
  }
}

const triggerWorkflow = () => {
  return new Promise((resolve, reject) => {
    let response = ''
    const body = JSON.stringify({
      ref: 'main'
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
      `${GET_WORKFLOWS_URL}?event=workflow_dispatch&status=in_progress OR waiting OR requested`,
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
  console.log('Triggering CI Visibility Test Environment Workflow')
  const httpResponseCode = await triggerWorkflow()
  console.log('GitHub API Response code:', httpResponseCode)
  // Give some time for GH to process the request
  await wait(5000)
  // Get the run ID from the workflow we just triggered
  const workflowsInProgress = await getWorkflowRunsInProgress()
  console.log('workflows in progress:', workflowsInProgress)
  const { total_count: numWorkflows, workflow_runs: workflows } = workflowsInProgress
  if (numWorkflows === 0) {
    throw new Error('Could not find the triggered job')
  }
  const [{ id: runId } = {}] = workflows

  console.log('Waiting for the workflow to finish.')
  console.log(`Job URL: https://github.com/DataDog/test-environment/actions/runs/${runId}`)
  // Poll every 10 seconds until we have a finished status
  await new Promise((resolve, reject) => {
    const intervalId = setInterval(async () => {
      const currentWorkflow = await getCurrentWorkflowJobs(runId)
      const { jobs: [{ status, conclusion }] } = currentWorkflow
      if (status === 'completed' && conclusion === 'success') {
        console.log('Performance overhead test successful')
        resolve()
        clearInterval(intervalId)
      } else if (status === 'completed' && conclusion !== 'success') {
        reject(new Error('Performance overhead test failed'))
      } else {
        console.log(`Checking the result of Job ${runId} again`)
      }
    }, 15000)
  })
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
