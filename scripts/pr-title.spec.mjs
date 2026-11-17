import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, it } from 'mocha'
import YAML from 'yaml'

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const rename = steps.get('Auto-rename GitHub revert title to Conventional Commit')
const checkout = steps.get('Checkout base revision')
const fetchHead = steps.get('Fetch pull request head')
const validation = steps.get('Validate PR title and release-note context')
const labelSync = steps.get('Sync labels with PR title')
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const scripts = {
  rename: fileURLToPath(new URL('pr-title/rename.js', import.meta.url)),
  syncLabels: fileURLToPath(new URL('pr-title/sync-labels.js', import.meta.url)),
  validate: fileURLToPath(new URL('pr-title/validate.js', import.meta.url)),
}
const workflowEnv = {
  PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN,
  SEMVER_MAJOR_LABEL_ID: job.env.SEMVER_MAJOR_LABEL_ID,
  SEMVER_MINOR_LABEL_ID: job.env.SEMVER_MINOR_LABEL_ID,
  SEMVER_PATCH_LABEL_ID: job.env.SEMVER_PATCH_LABEL_ID,
}
const commandShim = String.raw`#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const prefix = 'PR_TITLE_' + command.toUpperCase()
fs.appendFileSync(process.env.PR_TITLE_COMMAND_LOG, JSON.stringify({
  command,
  args: process.argv.slice(2),
}) + '\n')
const outputFile = process.env[prefix + '_OUTPUT_FILE']
if (outputFile) process.stdout.write(fs.readFileSync(outputFile))
process.exitCode = Number(process.env[prefix + '_EXIT_CODE'] || 0)
`
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const pullRequestEvent = ({ title, labels = [], action = 'opened', previousTitle }) => ({
  action,
  changes: previousTitle === undefined ? undefined : { title: { from: previousTitle } },
  pull_request: {
    number: 1,
    node_id: 'pull-request-id',
    title,
    labels,
    base: { sha: 'base-sha' },
  },
})

const readCommands = (logPath) => {
  const contents = fs.readFileSync(logPath, 'utf8').trim()
  return contents ? contents.split('\n').map(line => JSON.parse(line)) : []
}

const runCli = ({ script, event, gitOutput = '', ghOutput = { data: {} }, env = {} }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-pr-title-'))
  temporaryDirectories.push(directory)

  const binDirectory = path.join(directory, 'bin')
  const eventPath = path.join(directory, 'event.json')
  const outputPath = path.join(directory, 'github-output')
  const commandLogPath = path.join(directory, 'commands.jsonl')
  const gitOutputPath = path.join(directory, 'git-output')
  const ghOutputPath = path.join(directory, 'gh-output')
  fs.mkdirSync(binDirectory)
  fs.writeFileSync(eventPath, JSON.stringify(event))
  fs.writeFileSync(outputPath, '')
  fs.writeFileSync(commandLogPath, '')
  fs.writeFileSync(gitOutputPath, gitOutput)
  fs.writeFileSync(ghOutputPath, typeof ghOutput === 'string' ? ghOutput : JSON.stringify(ghOutput))

  for (const command of ['gh', 'git']) {
    const commandPath = path.join(binDirectory, command)
    fs.writeFileSync(commandPath, commandShim)
    fs.chmodSync(commandPath, 0o755)
  }

  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...workflowEnv,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'DataDog/dd-trace-js',
      GH_TOKEN: 'test-token',
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH || ''}`,
      PR_TITLE_COMMAND_LOG: commandLogPath,
      PR_TITLE_GIT_OUTPUT_FILE: gitOutputPath,
      PR_TITLE_GH_OUTPUT_FILE: ghOutputPath,
      ...env,
    },
  })

  return {
    commands: readCommands(commandLogPath),
    output: fs.readFileSync(outputPath, 'utf8'),
    result,
  }
}

const runValidation = (title, files = []) => runCli({
  script: scripts.validate,
  event: pullRequestEvent({ title }),
  gitOutput: `${files.join('\0')}${files.length ? '\0' : ''}`,
})

const runLabelSync = ({ title, labels = [], action = 'opened', previousTitle, ...options }) => runCli({
  script: scripts.syncLabels,
  event: pullRequestEvent({ title, labels, action, previousTitle }),
  ...options,
})

describe('PR title workflow', () => {
  it('rejects public release-note types for internal-only changes', () => {
    for (const type of ['feat', 'fix', 'perf', 'docs']) {
      const { result } = runValidation(`${type}(http): change`, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/test/index.spec.js',
      ])
      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, new RegExp(
        `PR title type "${type}" is public, but every changed file is internal. ` +
        'Use test, bench, ci, or chore.'
      ))
    }
  })

  it('allows public release-note types when any changed file is public', () => {
    const titles = [
      'feat(http): change',
      'fix(http): change',
      'perf(http): change',
      'docs(test): change',
    ]

    for (const title of titles) {
      const { result } = runValidation(title, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/src/index.js',
      ])
      assert.strictEqual(result.status, 0, result.stderr)
    }
  })

  it('rejects invalid titles through the CLI exit status', () => {
    const { commands, result } = runValidation('invalid title')

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /PR title does not follow Conventional Commits format/)
    assert.deepStrictEqual(commands, [])
  })

  it('skips file inspection for internal title types', () => {
    for (const type of ['test', 'bench', 'ci', 'chore']) {
      const { commands, result } = runValidation(`${type}(http): change`)
      assert.strictEqual(result.status, 0, result.stderr)
      assert.deepStrictEqual(commands, [])
    }
  })

  it('derives changed paths from the fetched PR ref without a GitHub API call', () => {
    const { commands, result } = runValidation('fix(http): change', ['packages/dd-trace/src/index.js'])

    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(commands, [{
      command: 'git',
      args: [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        'base-sha...refs/remotes/pull-request/head',
      ],
    }])
  })

  it('auto-renames GitHub revert titles through the CLI', () => {
    const { commands, output, result } = runCli({
      script: scripts.rename,
      event: pullRequestEvent({ title: 'Revert "fix(http): change"' }),
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.match(result.stdout, /Auto-renaming PR title to: revert: fix\(http\): change/)
    assert.strictEqual(output, 'renamed=true\n')
    assert.deepStrictEqual(commands, [{
      command: 'gh',
      args: [
        'api',
        '--method',
        'PATCH',
        'repos/DataDog/dd-trace-js/pulls/1',
        '--raw-field',
        'title=revert: fix(http): change',
        '--silent',
      ],
    }])
  })

  it('propagates title update failures through the CLI exit status', () => {
    const { output, result } = runCli({
      script: scripts.rename,
      event: pullRequestEvent({ title: 'Revert "fix(http): change"' }),
      env: { PR_TITLE_GH_EXIT_CODE: '1' },
    })

    assert.strictEqual(result.status, 1)
    assert.strictEqual(output, '')
  })

  it('syncs only the semver label in one GraphQL request', () => {
    const { commands, result } = runLabelSync({
      title: 'fix(http, tests): change',
      labels: [
        { name: 'fix', node_id: 'fix-id' },
        { name: 'http', node_id: 'http-id' },
        { name: 'semver-minor', node_id: job.env.SEMVER_MINOR_LABEL_ID },
      ],
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(commands.length, 1)
    assert.strictEqual(commands[0].command, 'gh')
    assert.deepStrictEqual(commands[0].args.slice(0, 4), ['api', 'graphql', '--method', 'POST'])
    const query = commands[0].args[commands[0].args.indexOf('--raw-field') + 1]
    assert.match(query, /addLabelsToLabelable/)
    assert.match(query, /removeLabelsFromLabelable/)
    const fields = commands[0].args.filter((arg, index, args) => args[index - 1] === '--field')
    assert.deepStrictEqual(fields, [
      'pullRequestId=pull-request-id',
      `addLabelIds[]=${job.env.SEMVER_PATCH_LABEL_ID}`,
      `removeLabelIds[]=${job.env.SEMVER_MAJOR_LABEL_ID}`,
      `removeLabelIds[]=${job.env.SEMVER_MINOR_LABEL_ID}`,
    ])
  })

  it('syncs same-semver edits when the event labels are missing or incorrect', () => {
    const labelSets = [
      [],
      [{ name: 'semver-minor' }],
      [{ name: 'semver-patch' }, { name: 'semver-minor' }],
    ]

    for (const labels of labelSets) {
      const { commands, result } = runLabelSync({
        title: 'fix(express): after',
        labels,
        action: 'edited',
        previousTitle: 'fix(http): before',
      })
      assert.strictEqual(result.status, 0, result.stderr)
      assert.strictEqual(commands.length, 1)
    }
  })

  it('does not sync same-semver edits when the event already has the valid semver label', () => {
    const { commands, result } = runLabelSync({
      title: 'fix(express): after',
      labels: [
        { name: 'http' },
        { name: 'semver-patch' },
      ],
      action: 'edited',
      previousTitle: 'fix(http): before',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(commands, [])
  })

  it('skips label synchronization for invalid titles', () => {
    const { commands, result } = runLabelSync({ title: 'invalid title' })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(commands, [])
  })

  it('propagates GraphQL errors through the CLI exit status', () => {
    const { commands, result } = runLabelSync({
      title: 'fix: change',
      ghOutput: { errors: [{ message: 'mutation failed' }] },
    })

    assert.strictEqual(commands.length, 1)
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /mutation failed/)
  })

  it('inspects files for every event unless the title was auto-renamed', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true'"

    for (const step of [fetchHead, validation]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), inspectionCondition)
    }
  })

  it('runs commands without inline workflow JavaScript', () => {
    assert.strictEqual(rename.run, 'node scripts/pr-title/rename.js')
    assert.strictEqual(validation.run, 'node scripts/pr-title/validate.js')
    assert.strictEqual(labelSync.run, 'node scripts/pr-title/sync-labels.js')
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses || '', /actions\/github-script/)
    }
  })

  it('skips label synchronization for dependency bot pull requests', () => {
    const titleCondition = "steps.rename.outputs.renamed != 'true' && " +
      "github.event.pull_request.user.login != 'dependabot[bot]' && " +
      "github.event.pull_request.user.login != 'renovate[bot]' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))"

    assert.strictEqual(labelSync.if.replaceAll(/\s+/g, ' '), titleCondition)
  })

  it('checks out only the trusted base and fetches the PR head without checking it out', () => {
    assert.strictEqual(job.steps[0], checkout)
    assert.strictEqual(checkout.if, undefined)
    assert.strictEqual(checkout.with.ref, '$' + '{{ github.sha }}')
    assert.strictEqual(checkout.with['fetch-depth'], 0)
    assert.strictEqual(checkout.with['persist-credentials'], false)
    assert.match(fetchHead.run, /refs\/pull\/\$\{PR_NUMBER\}\/head/)
    assert.match(fetchHead.run, /refs\/remotes\/pull-request\/head/)
  })
})
