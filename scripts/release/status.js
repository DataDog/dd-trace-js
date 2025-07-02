'use strict'

/* eslint-disable no-console */

const util = require('util')

const { GITHUB_REF, GITHUB_TOKEN } = process.env

const TIMEOUT = 10 * 1000
const MAX_ATTEMPTS = 30

let attempts = 0

async function checkStatuses (contexts) {
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

    throw new Error(
      util.format('Could not get status from GitHub.\n\n%o\n\n%s', response, response.text?.())
    )
  }

  const { statuses } = JSON.parse(await response.text())

  for (const status of statuses) {
    if (!contexts.has(status.context)) continue

    switch (status.state) {
      case 'success':
        contexts.delete(status.context)
        break
      case 'cancelled':
      case 'failure':
      case 'stale':
      case 'timed_out':
        throw new Error(`Job was not successful: ${status.context}.`)
    }
  }

  if (contexts.size === 0) return

  attempts++

  if (attempts >= MAX_ATTEMPTS) {
    throw new Error(`Jobs did not finish before timeout: ${[...contexts].join(', ')}.`)
  }

  setTimeout(() => checkStatuses(contexts), TIMEOUT)
}

checkStatuses(new Set([
  'dd-gitlab/promote-oci-to-prod',
  'dd-gitlab/publish-lib-init-ghcr-tags'
]))
