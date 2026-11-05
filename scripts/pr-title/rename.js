'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const renamePullRequest = async ({ context, updateTitle, setOutput }) => {
  const title = context.payload.pull_request.title
  const match = title.match(/^Revert "(.+)"$/)
  if (!match) return

  const newTitle = `revert: ${match[1]}`
  await updateTitle(newTitle)
  setOutput('renamed', 'true')
}

const main = async () => {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const context = { payload: event }

  await renamePullRequest({
    context,
    updateTitle: (title) => {
      process.stdout.write(`::notice::Auto-renaming PR title to: ${title}\n`)
      execFileSync('gh', [
        'api',
        '--method',
        'PATCH',
        `repos/${process.env.GITHUB_REPOSITORY}/pulls/${event.pull_request.number}`,
        '--raw-field',
        `title=${title}`,
        '--silent',
      ])
    },
    setOutput: (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`),
  })
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}

module.exports = { renamePullRequest }
