import { setTimeout } from 'timers/promises'
import { Octokit } from 'octokit'

/* eslint-disable no-console */

const {
  DELAY,
  GITHUB_PR_NUMBER,
  GITHUB_SHA,
  GITHUB_TOKEN,
  POLLING_INTERVAL,
  RETRIES,
} = process.env

const octokit = new Octokit({ auth: GITHUB_TOKEN })

let retries = 0

async function getStatus () {
  const owner = 'DataDog'
  const name = 'dd-trace-js'

  if (GITHUB_PR_NUMBER) { // For `pull_request` trigger.
    const response = await octokit.graphql(`
      query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup { state }
                }
              }
            }
          }
        }
      }
    `, {
      owner,
      name,
      number: Number(GITHUB_PR_NUMBER),
    })

    return response.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.state
  } else if (GITHUB_SHA) { // For `push` and `schedule` triggers.
    const response = await octokit.graphql(`
      query ($owner: String!, $name: String!, $oid: GitObjectID!) {
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              statusCheckRollup { state }
            }
          }
        }
      }
    `, {
      owner,
      name,
      oid: GITHUB_SHA,
    })

    return response.repository.object.statusCheckRollup.state
  }

  throw new Error('Please provide at least one of GITHUB_PR_NUMBER or GITHUB_SHA.')
}

async function checkStatus () {
  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

  const status = await getStatus()

  if (status === 'PENDING') {
    console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    console.log('Retrying.')
    retries++
    return checkStatus()
  }

  // Since `statusCheckRollup` is used in both queries, this will happen as soon
  // as any job fails. This is intended as it will prevent further API calls.
  if (status === 'FAILURE' || status === 'ERROR') {
    console.log('One or more jobs failed.')
  } else {
    console.log('All jobs were succesful.')
  }
}

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  await setTimeout(DELAY * 60_000)
}

await checkStatus()
