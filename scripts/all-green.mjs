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
            statusCheckRollup {
              # Overall state: SUCCESS, FAILURE, PENDING, or ERROR
              state
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    url
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
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
  const status = await getStatus()
  const state = status.repository.object.statusCheckRollup.state

  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

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
  setTimeout(DELAY * 60_000)
}

checkStatus()
