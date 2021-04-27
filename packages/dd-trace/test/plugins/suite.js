'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const util = require('util')
const os = require('os')
const path = require('path')
const https = require('https')

const mkdtemp = util.promisify(fs.mkdtemp)

const ddTraceInit = path.resolve('../../../../init')

const latestCache = []
async function getLatest (modName, repoUrl) {
  if (latestCache[modName]) {
    return latestCache[modName]
  }
  const { stdout } = await exec(`npm view ${modName} dist-tags --json`)
  const { latest } = JSON.parse(stdout)
  const tags = await get(`https://api.github.com/repos/${repoUrl}/git/refs/tags`)
  for (const tag of tags) {
    if (tag.ref.includes(latest)) {
      return tag.split('/').pop()
    }
  }
}

function get (url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300) {
        reject(new Error(res.statusCode))
        return
      }
      const data = []
      res.on('data', d => data.push(d))
      res.on('end', () => {
        resolve(JSON.parse(Buffer.concat(data).toString('utf8')))
      })
    }).on('error', reject)
  })
}

function exec (cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, Object.assign({
      shell: true
    }, opts))
    proc.on('error', reject)
    const results = {
      stdout: [],
      stderr: []
    }
    proc.stdout.on('data', d => results.stdout.push(d))
    proc.stderr.on('data', d => results.stderr.push(d))
    proc.on('exit', code => {
      results.code = code
      results.stdout = Buffer.concat(results.stdout).toString('utf8')
      results.stderr = Buffer.concat(results.stderr).toString('utf8')
      resolve(results)
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

async function runOne (modName, repoUrl, commitish, withTracer, testCmd) {
  if (commitish === 'latest') {
    commitish = await getLatest(modName, repoUrl)
  }
  const cwd = await getTmpDir()
  await execOrError(`git clone https://github.com/${repoUrl}.git ${cwd}`)
  await execOrError(`git checkout ${commitish}`, { cwd })
  const env = Object.assign({}, process.env)
  if (withTracer) {
    env.NODE_OPTIONS = `--require ${ddTraceInit}`
  }
  await execOrError(`npm install`, { cwd })
  const result = await exec(testCmd, { cwd, env })
  await execOrError(`rm -rf ${cwd}`)
  return result
}

async function run (modName, repoUrl, commitish, testCmd) {
  const withoutTracer = await runOne(modName, repoUrl, commitish, false, testCmd)
  const withTracer = await runOne(modName, repoUrl, commitish, true, testCmd)
  return { withoutTracer, withTracer }
}

function defaultRunner ({ withoutTracer, withTracer }) {
  try {
    expect(withTracer.code).to.equal(0)
    expect(withTracer.code).to.equal(withoutTracer.code)
  } catch (e) {
    // eslint-disable-next-line no-console
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

const DEFAULT_TIMEOUT = 10 * 60 * 1000 // 10 min

function getOpts (args) {
  args = Array.from(args)
  const [ modName, repoUrl, commitish, runner, timeout, testCmd ] = args
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

function runWithMocha (fn, options) {
  if (typeof options !== 'object') {
    options = getOpts(Array.prototype.slice.call(arguments, 1))
  }
  const {
    modName,
    repoUrl,
    commitish,
    testCmd = 'npm test',
    runner = defaultRunner,
    timeout = DEFAULT_TIMEOUT
  } = options
  fn('should pass equivalently with and without tracer for ' + commitish, async function () {
    this.timeout(timeout)
    return runner.call(this, await run(modName, repoUrl, commitish, testCmd))
  })
}

module.exports = (...args) => runWithMocha(it, ...args)
module.exports.only = (...args) => runWithMocha(it.only, ...args)
module.exports.skip = (...args) => runWithMocha(it.skip, ...args)
