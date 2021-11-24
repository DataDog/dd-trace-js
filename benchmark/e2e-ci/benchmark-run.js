const https = require('https')

const triggerWorkflow = () => {
  return new Promise((resolve, reject) => {
    let response = ''
    const body = JSON.stringify({
      ref: 'main'
    })
    const request = https.request('https://api.github.com/repos/DataDog/test-environment/actions/workflows/dd-trace-js-tests.yml/dispatches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'authorization': `Bearer ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'user-agent': 'dd-trace benchmark tests'
      }
    }, (res) => {
      res.on('data', (chunk) => {
        response += chunk
      })
      res.on('end', () => {
        resolve(JSON.parse(response))
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
    let body = ''
    const request = https.request(
      'https://api.github.com/repos/DataDog/test-environment/actions/runs?event=workflow_dispatch&status=in_progress OR waiting OR requested',
      {
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'user-agent': 'dd-trace benchmark tests'
        }
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

const getCurrentWorkflowJobs = (runId) => {
  let body = ''
  return new Promise((resolve, reject) => {
    if (!runId) {
      reject(new Error('no job id'))
      return
    }
    const request = https.request(
      `https://api.github.com/repos/DataDog/test-environment/actions/runs/${runId}/jobs`,
      {
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'user-agent': 'dd-trace benchmark tests'
        }
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
  // trigger JS GHA
  triggerWorkflow()

  // give some time for GH to process the request
  await wait(1000)

  const res = await getWorkflowRunsInProgress()
  const { workflow_runs: workflows } = res
  const [{ id: runId } = {}] = workflows

  // Poll every 10 seconds until we have a finished status
  await new Promise((resolve, reject) => {
    const intervalId = setInterval(async () => {
      const currentWorkflow = await getCurrentWorkflowJobs(runId)
      const { jobs: [{ status, conclusion }] } = currentWorkflow
      if (status === 'completed' && conclusion === 'success') {
        resolve()
        clearInterval(intervalId)
      } else if (status === 'completed' && conclusion !== 'success') {
        reject(new Error('failed performance overhead test'))
      }
    }, 10000)
  })
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
