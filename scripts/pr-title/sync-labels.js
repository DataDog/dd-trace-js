'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const { parseTitle } = require('./title')

const SYNC_SEMVER_LABEL_MUTATION = `
  mutation SyncSemverLabel($pullRequestId: ID!, $addLabelIds: [ID!]!, $removeLabelIds: [ID!]!) {
    addLabelsToLabelable(input: { labelableId: $pullRequestId, labelIds: $addLabelIds }) {
      clientMutationId
    }
    removeLabelsFromLabelable(input: { labelableId: $pullRequestId, labelIds: $removeLabelIds }) {
      clientMutationId
    }
  }
`

// Reverts are always semver-patch regardless of the original change's type.
const semverFor = ({ type, breaking }) => {
  if (breaking) return 'semver-major'
  if (type === 'feat') return 'semver-minor'
  return 'semver-patch'
}

const syncLabels = async ({ context, github, env = process.env }) => {
  const pullRequest = context.payload.pull_request
  const parsed = parseTitle(pullRequest.title, env.PR_TITLE_PATTERN)
  if (!parsed) return

  const semver = semverFor(parsed)
  const semverLabels = new Map([
    ['semver-major', env.SEMVER_MAJOR_LABEL_ID],
    ['semver-minor', env.SEMVER_MINOR_LABEL_ID],
    ['semver-patch', env.SEMVER_PATCH_LABEL_ID],
  ])
  const current = (pullRequest.labels || []).filter(label => semverLabels.has(label.name))
  if (current.length === 1 && current[0].name === semver) return

  const removeLabelIds = [...semverLabels]
    .filter(([name]) => name !== semver)
    .map(([, id]) => id)

  await github.graphql(SYNC_SEMVER_LABEL_MUTATION, {
    pullRequestId: pullRequest.node_id,
    addLabelIds: [semverLabels.get(semver)],
    removeLabelIds,
  })
}

const graphqlWithGh = (query, variables, runCommand = execFileSync) => {
  const args = ['api', 'graphql', '--method', 'POST', '--raw-field', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) {
    if (Array.isArray(value)) {
      for (const item of value) args.push('--field', `${name}[]=${item}`)
    } else {
      args.push('--field', `${name}=${value}`)
    }
  }

  const result = JSON.parse(runCommand('gh', args, { encoding: 'utf8' }))
  if (result.errors?.length) {
    throw new Error(result.errors.map(error => error.message).join('; '))
  }
}

const main = async () => {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  await syncLabels({
    context: { payload: event },
    github: { graphql: graphqlWithGh },
  })
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
