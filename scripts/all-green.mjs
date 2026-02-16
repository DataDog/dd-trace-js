import { setTimeout } from 'timers/promises'
import { Octokit } from 'octokit'

/* eslint-disable no-console */

const {
  DELAY,
  GITHUB_SHA,
  GITHUB_TOKEN,
  POLLING_INTERVAL,
  RETRIES,
} = process.env

const octokit = new Octokit({ auth: GITHUB_TOKEN })

let retries = 0

async function getStatus () {
  const response = await octokit.graphql(`
    query ($owner: String!, $name: String!, $oid: GitObjectID!) {
      repository(owner: $owner, name: $name) {
        object(oid: $oid) {
          ... on Commit {
            # 1. Direct Commit Rollup (Push/Schedule)
            statusCheckRollup { state }
            # 2. PR-specific Rollup (Pull Request)
            associatedPullRequests(first: 1) {
              nodes {
                headRef {
                  target {
                    ... on Commit {
                      statusCheckRollup { state }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, {
    owner: 'DataDog',
    name: 'dd-trace-js',
    oid: GITHUB_SHA,
  })

  return response
}

async function checkStatus () {
  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

  const status = await getStatus()
  const { associatedPullRequests, statusCheckRollup } = status.repository.object
  const prState = associatedPullRequests?.nodes[0]?.headRef?.target?.statusCheckRollup?.state
  const commitState = statusCheckRollup?.state
  const state = commitState || prState

  console.log(GITHUB_SHA)
  console.log(associatedPullRequests)

  if (state === 'PENDING') {
    console.log(`State is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    console.log('Retrying.')
    retries++
    return checkStatus()
  }

  if (state === 'FAILURE' || state === 'ERROR') {
    console.log('One or more jobs failed.')
  } else {
    console.log('All jobs were succesful.')
  }
}

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  // await setTimeout(DELAY * 60_000)
}

await checkStatus()
