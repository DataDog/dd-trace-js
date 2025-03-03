'use strict'

/* eslint-disable no-console */

const { GITHUB_REF, GITHUB_TOKEN } = process.env

const CONTEXT = 'dd-gitlab/default-pipeline'
const TIMEOUT = 60 * 1000
const MAX_ATTEMPTS = 10

let attempts = 0

async function checkStatus () {
  const url = `https://api.github.com/repos/DataDog/dd-trace-js/commits/${GITHUB_REF}/status`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })

  if (response.status !== 200) {
    console.log(response)
    console.log(response.text())

    throw new Error('Could not get status from GitHub.')
  }

  const { statuses } = JSON.parse(await response.text())

  for (const status of statuses) {
    if (status.context === CONTEXT) {
      switch (status.state) {
        case 'success':
          return
        case 'cancelled':
        case 'failure':
        case 'stale':
        case 'timed_out':
          throw new Error(
            `The ${CONTEXT} GitLab job was not successful. The OCI image may not have been published.`
          )
      }
    }
  }

  attempts++

  if (attempts > MAX_ATTEMPTS) {
    setTimeout(checkStatus, TIMEOUT)
  }
}

checkStatus()
