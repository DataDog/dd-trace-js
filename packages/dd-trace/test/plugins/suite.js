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

function getTmpDir () {
  const prefix = path.join(os.tmpdir(), 'dd-trace-js-suites-')
  return mkdtemp(prefix)
}

async function runOne (modName, repoUrl, commitish, withTracer) {
  if (commitish === 'latest') {
    commitish = await getLatest(modName, repoUrl)
  }
  const cwd = await getTmpDir()
  await exec(`git clone https://github.com/${repoUrl}.git ${cwd}`)
  await exec(`git checkout ${commitish}`, { cwd })
  const env = Object.assign({}, process.env)
  if (withTracer) {
    env.NODE_OPTIONS = `--require ${ddTraceInit}`
  }
  await exec(`npm install`, { cwd })
  const result = await exec(`npm test`, { cwd, env })
  await exec(`rm -rf ${cwd}`)
  return result
}

async function run (repoUrl, commitish) {
  const withoutTracer = await runOne(repoUrl, commitish, false)
  const withTracer = await runOne(repoUrl, commitish, true)
  return { withoutTracer, withTracer }
}

function defaultRunner ({ withoutTracer, withTracer }) {
  expect(withTracer.code).to.equal(0)
  expect(withTracer.code).to.equal(withoutTracer.code)
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000 // 10 min

function runWithMocha (fn, modName, repoUrl, commitish, runner = defaultRunner, timeout = DEFAULT_TIMEOUT) {
  if (arguments.length === 3 && typeof runner === 'number') {
    timeout = runner
    runner = defaultRunner
  }
  fn('should pass equivalently with and without tracer for ' + commitish, async function () {
    this.timeout(timeout)
    return runner.call(this, await run(modName, repoUrl, commitish))
  })
}

module.exports = (...args) => runWithMocha(it, ...args)
module.exports.only = (...args) => runWithMocha(it.only, ...args)
module.exports.skip = (...args) => runWithMocha(it.skip, ...args)
