'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const util = require('util')
const os = require('os')
const path = require('path')
const https = require('https')
const url = require('url')
const { once } = require('events')
const { expect } = require('chai')

const mkdtemp = util.promisify(fs.mkdtemp)

const ddTraceInit = path.resolve(__dirname, '../../../../init')

const latestCache = []
async function getLatest (withTracer, modName, repoUrl) {
  if (latestCache[modName]) {
    return latestCache[modName]
  }
  const { stdout } = await exec(withTracer, `npm view ${modName} dist-tags --json`)
  const { latest } = JSON.parse(stdout)
  const tags = await get(`https://api.github.com/repos/${repoUrl}/git/refs/tags`)
  for (const tag of tags) {
    if (tag.ref.includes(latest)) {
      return tag.ref.split('/').pop()
    }
  }
}

function get (theUrl) {
  return new Promise((resolve, reject) => {
    const options = url.parse(theUrl)
    options.headers = {
      'user-agent': 'dd-trace plugin test suites'
    }
    https.get(options, res => {
      if (res.statusCode >= 300) {
        res.pipe(process.stderr)
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

function exec (withTracer, cmd, opts = {}) {
  // eslint-disable-next-line no-console
  console.log(withTracer ? 'WITH TRACER' : '  NO TRACER', `-> (${new Date()}) running \`${cmd}\` ...`)
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, Object.assign({
      shell: true
    }, opts))
    proc.on('error', reject)
    const stdout = []
    const stderr = []
    proc.stdout.on('data', d => {
      stdout.push(d)
      process.stdout.write(d)
    })
    proc.stderr.on('data', d => {
      stderr.push(d)
      process.stderr.write(d)
    })
    proc.on('exit', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

async function execOrError (withTracer, cmd, opts = {}) {
  const result = await exec(withTracer, cmd, opts)
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
    commitish = await getLatest(withTracer, modName, repoUrl)
  }
  const cwd = await getTmpDir()
  await execOrError(withTracer, `git clone https://github.com/${repoUrl}.git ${cwd}`)
  await execOrError(withTracer, `git checkout ${commitish}`, { cwd })
  const env = Object.assign({}, process.env)
  if (withTracer) {
    env.NODE_OPTIONS = `--require ${ddTraceInit}`
  }
  await execOrError(withTracer, `npm install`, { cwd })
  const result = await exec(withTracer, testCmd, { cwd, env })
  await execOrError(withTracer, `rm -rf ${cwd}`)
  return result
}

async function run (modName, repoUrl, commitish, testCmd, parallel) {
  if (parallel) {
    const [withoutTracer, withTracer] = await Promise.all([
      runOne(modName, repoUrl, commitish, false, testCmd),
      runOne(modName, repoUrl, commitish, true, testCmd)
    ])

    return { withoutTracer, withTracer }
  } else {
    const withoutTracer = await runOne(modName, repoUrl, commitish, false, testCmd)
    const withTracer = await runOne(modName, repoUrl, commitish, true, testCmd)

    return { withoutTracer, withTracer }
  }
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
    // eslint-disable-next-line no-console
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
      if (fs.existsSync(suitePath)) {
        const proc = childProcess.spawn('node', [suitePath], { stdio: 'inherit' })
        const code = await once(proc, 'exit')
        if (code !== 0) {
          process.exitCode = code
          break
        }
      } else {
        // eslint-disable-next-line no-console
        console.log('no test file found at', suitePath)
      }
    }
  })()
}
