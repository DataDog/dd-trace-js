'use strict'

/* eslint-disable no-console */

const childProcess = require('child_process')
const fs = require('fs')
const util = require('util')
const os = require('os')
const path = require('path')
const { once } = require('events')
const { expect } = require('chai')
const latests = require('../plugins/versions/package.json').dependencies

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

const mkdtemp = util.promisify(fs.mkdtemp)

const ddTraceInit = path.resolve(__dirname, '../../../../init')

function exec (cmd, opts = {}) {
  const date = new Date()
  const time = [
    String(date.getHours()).padStart(2, 0),
    String(date.getMinutes()).padStart(2, 0),
    String(date.getSeconds()).padStart(2, 0)
  ].join(':')
  console.log(time, '❯', cmd)
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, Object.assign({
      shell: true
    }, opts))
    proc.on('error', reject)
    const stdout = []
    const stderr = []
    proc.stdout.on('data', d => stdout.push(d))
    proc.stderr.on('data', d => stderr.push(d))
    proc.on('exit', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

async function execOrError (cmd, opts = {}) {
  const result = await exec(cmd, opts)
  if (result.code !== 0) {
    const err = new Error(`command "${cmd}" exited with code ${result.code}`)
    err.result = result
    throw err
  }
  return result
}

function getTmpDir () {
  const prefix = path.join(os.tmpdir(), 'dd-trace-js-suites-')
  return mkdtemp(prefix)
}

async function setup (modName, repoName, commitish) {
  if (commitish === 'latest') {
    commitish = latests[modName]
  }
  const repoUrl = `https://github.com/${repoName}.git`
  const cwd = await getTmpDir()
  const clone = `git clone ${repoUrl} --single-branch ${cwd}`

  try {
    await execOrError(`${clone} --branch ${commitish}`)
  } catch {
    // Exact version doesn't exist, try with a `v` prefix for example `v1.2.3`.
    await execOrError(`${clone} --branch v${commitish}`)
  }

  try {
    await execOrError('npm install --legacy-peer-deps', { cwd })
  } catch (e) {
    console.error(e)
    await execOrError('npm install --legacy-peer-deps', { cwd })
  }
}

async function cleanup () {
  const cwd = await getTmpDir()
  await execOrError(`rm -rf ${cwd}`)
}

async function runOne (withTracer, testCmd) {
  const cwd = await getTmpDir()
  const env = Object.assign({}, process.env)
  if (withTracer) {
    testCmd = `NODE_OPTIONS='-r ${ddTraceInit}' ${testCmd}`
  }
  const result = await exec(testCmd, { cwd, env })
  return result
}

async function run (modName, repoUrl, commitish, testCmd, parallel) {
  await setup(modName, repoUrl, commitish)

  const result = await parallel ? runParallel(testCmd) : runSequential(testCmd)

  await cleanup()

  return result
}

async function runParallel (testCmd) {
  const [withoutTracer, withTracer] = await Promise.all([
    runOne(false, testCmd),
    runOne(true, testCmd)
  ])

  return { withoutTracer, withTracer }
}

async function runSequential (testCmd) {
  const withoutTracer = await runOne(false, testCmd)
  const withTracer = await runOne(true, testCmd)

  return { withoutTracer, withTracer }
}

function defaultRunner ({ withoutTracer, withTracer }) {
  try {
    expect(withTracer.code).to.equal(withoutTracer.code)
  } catch (e) {
    console.log(`======= BEGIN STDOUT WITHOUT TRACER
${withoutTracer.stdout}
======= BEGIN STDERR WITHOUT TRACER
${withoutTracer.stderr}
======= BEGIN STDOUT WITH TRACER
${withTracer.stdout}
======= BEGIN STDERR WITH TRACER
${withTracer.stderr}
`)
    throw e
  }
}

function getOpts (args) {
  args = Array.from(args)
  const [modName, repoUrl, commitish, runner, timeout, testCmd] = args
  const options = {
    modName,
    repoUrl,
    commitish,
    testCmd,
    runner,
    timeout
  }
  if (testCmd) {
    options.testCmd = testCmd
  }
  if (runner) {
    options.runner = runner
  }
  if (timeout) {
    options.timeout = timeout
  }
  return options
}

module.exports = async function runWithOptions (options) {
  try {
    if (typeof options !== 'object') {
      options = getOpts(Array.from(arguments))
    }
    const {
      modName,
      repoUrl,
      commitish,
      testCmd = 'npm test',
      runner = defaultRunner,
      parallel = true
    } = options
    return runner(await run(modName, repoUrl, commitish, testCmd, parallel))
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
}

if (require.main === module) {
  const { PLUGINS } = process.env
  const plugins = PLUGINS.split('|')
  ;(async () => {
    for (const plugin of plugins) {
      const suitePath = path.join(__dirname, `../../../datadog-plugin-${plugin}/test/suite.js`)
      const altSuitePath = path.join(__dirname, `../../../datadog-instrumentations/test/${plugin}.suite.js`)
      if (fs.existsSync(suitePath)) {
        const proc = childProcess.spawn('node', [suitePath], { stdio: 'inherit' })
        const [code] = await once(proc, 'exit')
        if (code !== 0) {
          process.exitCode = code
          break
        }
      } else if (fs.existsSync(altSuitePath)) {
        const proc = childProcess.spawn('node', [altSuitePath], { stdio: 'inherit' })
        const [code] = await once(proc, 'exit')
        if (code !== 0) {
          process.exitCode = code
          break
        }
      } else {
        console.log('no test file found at', suitePath, 'or', altSuitePath)
      }
    }
  })()
}
