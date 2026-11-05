'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const { isInternalOnly } = require('../release/changelog')
const { parseTitle } = require('./title')

const validateTitle = ({ context, core, env = process.env, runGit = execFileSync }) => {
  const pullRequest = context.payload.pull_request
  const title = pullRequest.title || ''
  const parsed = parseTitle(title, env.PR_TITLE_PATTERN)
  if (!parsed) {
    core.setFailed('PR title does not follow Conventional Commits format.')
    return
  }
  core.info(`PR title OK: ${title}`)

  if (!/^(?:feat|fix|perf|docs)$/.test(parsed.type)) return

  // Treat renames as delete/add pairs so both paths affect classification.
  const output = runGit('git', [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    `${pullRequest.base.sha}...refs/remotes/pull-request/head`,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const files = output.split('\0').filter(Boolean)

  if (isInternalOnly(files)) {
    core.setFailed(`PR title type "${parsed.type}" is public, but every changed file is internal. ` +
      'Use test, bench, ci, or chore.')
  }
}

const main = () => {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  validateTitle({
    context: { payload: event },
    core: {
      info: message => process.stdout.write(`${message}\n`),
      setFailed: message => { throw new Error(message) },
    },
  })
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  }
}

module.exports = { validateTitle }
