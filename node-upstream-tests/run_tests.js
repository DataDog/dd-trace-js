'use strict'

/* eslint-disable no-console */

const promisify = require('util').promisify
const axios = require('axios')
const childProcess = require('child_process')
const fs = require('fs')
const glob = promisify(require('glob'))
const path = require('path')

const NODE_BIN = process.env['NODE_BIN'] || '/usr/bin/node'
const NODE_REPO_PATH = process.env['NODE_PROJECT']
if (NODE_REPO_PATH === undefined) {
  throw new Error('The env variable NODE_PROJECT is not set. This is required to locate the root of the nodejs repo')
}

const NEEDS_TO_SPAWN_AGENT = false

const MODULES = [
  'dns',
  'fs',
  'tcp',
  'http',
  'http2',
  'net'
]

// Taken from nodeJS repo.
// These are not run by default on their CI because they require special setups
const IGNORED_SUITES = [
  'addons',
  'benchmark',
  'doctool',
  'embedding',
  'internet',
  'js-native-api',
  'node-api',
  'pummel',
  'tick-processor',
  'v8-updates'
]

const TRACING_HEADERS = [
  'x-datadog-trace-id',
  'x-datadog-parent-id',
  'x-datadog-sampled'
]

const UNEXPECTED_FAILURES = [
  'test/parallel/test-dns-lookup-promises.js',
  'test/parallel/test-dns-lookup.js',
  'test/parallel/test-dns-lookupService.js',
  'test/async-hooks/test-http-agent-handle-reuse-parallel.js',
  'test/async-hooks/test-http-agent-handle-reuse-serial.js',
  'test/parallel/test-http-client-check-http-token.js',
  'test/parallel/test-http-invalid-urls.js',
  'test/parallel/test-http-max-headers-count.js',
  'test/parallel/test-http-parser-lazy-loaded.js',
  'test/sequential/test-http2-timeout-large-write-file.js',
  'test/parallel/test-net-connect-call-socket-connect.js',
  'test/parallel/test-http2-padding-aligned.js',
  'test/parallel/test-http-same-map.js',
  'test/parallel/test-http-deprecated-urls.js',
  'test/parallel/test-fs-access.js',
  'test/parallel/test-fs-chmod.js',
  'test/parallel/test-fs-chown-type-check.js',
  'test/parallel/test-fs-close-errors.js',
  'test/parallel/test-fs-copyfile.js',
  'test/parallel/test-fs-error-messages.js',
  'test/parallel/test-fs-fchmod.js',
  'test/parallel/test-fs-fchown.js',
  'test/parallel/test-fs-fsync.js',
  'test/parallel/test-fs-lchmod.js',
  'test/parallel/test-fs-lchown.js',
  'test/parallel/test-fs-make-callback.js',
  'test/parallel/test-fs-makeStatsCallback.js',
  'test/parallel/test-fs-open.js',
  'test/parallel/test-fs-opendir.js',
  'test/parallel/test-fs-read.js',
  'test/parallel/test-fs-realpath-native.js',
  'test/parallel/test-fs-realpath.js',
  'test/parallel/test-fs-stat.js',
  'test/parallel/test-fs-truncate.js'
]

// These tests trigger a stackoverflow in the test agent because
// traces are too deep
const TEST_AGENT_IGNORE = [
  'test/parallel/test-http-pipeline-requests-connection-leak.js',
  'test/parallel/test-http2-forget-closed-streams.js'
]

const readFile = promisify(fs.readFile)
const acess = promisify(fs.access)
const stat = promisify(fs.stat)

async function pathExists (path) {
  try {
    await acess(path)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false
    }
    throw e
  }
}

async function samePath (path, other) {
  const pathStat = await stat(path)
  const otherStat = await stat(other)
  return pathStat.ino === otherStat.ino
}

function runCmd (cmd, errorOnCode = false, options) {
  return new Promise((resolve, reject) => {
    try {
      const process = childProcess.spawn(cmd[0], cmd.slice(1), options)

      process.on('error', (e) => {
        reject(e)
      })

      const data = { stdout: '', stderr: '' }
      for (const out of ['stdout', 'stderr']) {
        data[out] = ''
        process[out].setEncoding('utf-8')
        process[out].on('data', (chunk) => {
          data[out] += chunk
        })
      }
      process.on('exit', (rc) => {
        if (errorOnCode && rc !== 0) {
          reject(new Error(`Command ${cmd.join(' ')} exited with rc: ${rc}\n stderr: ${data.stderr}`))
        }
        resolve({ rc, ...data })
      })
    } catch (e) {
      reject(e)
    }
  })
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listJsTests (nodeRepoPath) {
  const tests = (await glob('test/**/test-*.js', { cwd: nodeRepoPath }))
    .map(testPath => {
      const moduleName = path.basename(testPath, '.js').split('-')[1]
      const abolutePath = path.join(nodeRepoPath, testPath)
      return { moduleName, testPath: abolutePath }
    })
  const shouldRun = await Promise.all(tests.map(({ moduleName, testPath }) => {
    return shouldRunTest(moduleName, testPath)
  }))
  return tests.filter((_, i) => shouldRun[i])
}

async function shouldRunTest (moduleName, testPath) {
  return (await pathExists(path.join(path.dirname(testPath), 'testcfg.py'))) &&
    MODULES.includes(moduleName) &&
    !IGNORED_SUITES.includes(path.basename(path.dirname(testPath)))
}

async function startTestAgent () {
  const cmd = [
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    'dd-test-agent',
    '-p',
    '8126:8126',
    'kyleverhoog/dd-trace-test-agent:latest'
  ]
  await runCmd(cmd, true)
}

async function stopTestAgent () {
  const cmd = ['docker', 'stop', 'dd-test-agent']
  await runCmd(cmd, true)
}

async function nodeVersion (nodeBin) {
  const { stdout } = await runCmd([nodeBin, '-v'], true)
  const version = stdout.trim()
  const match = version.match(/v(\d+)(\.[a-z0-9]+){0,2}/)
  if (match === null) {
    throw new Error(`Unexpected node version output u: ${version}`)
  }
  return { version, major: match[1] }
}

async function nodeRepoVersion (repoPath) {
  const { stdout } = await runCmd(['git', 'branch', '--show-current'], true, { cwd: repoPath })
  const version = stdout.trim()
  const match = version.match(/v(\d+)(\.[a-z0-9]+){0,2}/)
  if (match === null) {
    throw new Error(`Unexpected node version output: ${version}`)
  }
  return { version, major: match[1] }
}

const AXIOS_CONFIG = {
  validateStatus: undefined,
  responseType: 'text',
  transformResponse: [(data) => data]
}

async function startAgentTest (testIdentifier) {
  const res = await axios(
    `http://127.0.0.1:8126/test/start?token=${testIdentifier}`,
    AXIOS_CONFIG
  )
  if (!res.status === 200) {
    throw new Error(
      `Error while starting a new test with the test agent\n` +
      `status: ${res.status} response: ${res.data}`
    )
  }
}

async function getAgentResult (testIdentifier) {
  const res = await axios(
    `http://127.0.0.1:8126/test/check?token=${testIdentifier}`,
    AXIOS_CONFIG
  )
  return { status: res.status, response: res.data }
}

async function findFlags (testPath) {
  const flags = []
  const content = await readFile(testPath, { encoding: 'utf-8' })
  for (const match of content.matchAll(/^\/\/\s+Flags:(.*)$/gm)) {
    flags.push(...match[1].trim().split(' '))
  }
  return flags
}

async function runTest (nodeBin, testPath) {
  const flags = await findFlags(testPath)
  const cmd = [
    nodeBin,
    ...flags,
    '--require',
    path.join(path.dirname(path.dirname(__filename)), 'init.js'),
    testPath
  ]
  return runCmd(cmd, false, { cwd: NODE_REPO_PATH })
}

async function runModuleTests (moduleName, tests) {
  console.log(`Running ${tests.length} tests for module ${moduleName}`)
  const results = []
  for (const test of tests) {
    const testIdentifier = path.basename(test, '.js')
    await startAgentTest(testIdentifier)

    const { rc, stderr } = await runTest(NODE_BIN, test)
    const { status, response } = await getAgentResult(testIdentifier)

    const result = await new TestResult(test, rc, stderr, status, response).init()
    results.push(result)
  }

  const failed = results.filter(r => !r.isPass && !r.isIgnore)
  const ignored = results.filter(r => !r.isPass && r.isIgnore)

  console.log(
    `Failed ${failed.length}/${results.length} tests, ` +
    `${ignored.length}/${results.length} ignored`
  )
  if (failed.length !== 0) {
    console.log('Failed tests:')
    for (const r of failed) {
      console.log(r.testPath)
      console.log(r.errorMessage(), '\n')
    }
  }
  return results
}

class TestResult {
  constructor (testPath, rc, stderr, statusCode, response) {
    this.testPath = testPath
    this.rc = rc
    this.stderr = stderr
    this.statusCode = statusCode
    this.response = response

    this.isPass = null
    this.isIgnore = null
  }
  async init () {
    const isAgentIgnore = (await Promise.all(TEST_AGENT_IGNORE.map(
      (ignore) => samePath(this.testPath, path.join(NODE_REPO_PATH, ignore))
    ))).some(same => same) ||
      this.response.includes('No traces found for token')

    this.isPass = this.rc === 0 &&
      (this.statusCode === 200 || isAgentIgnore)

    this.isIgnore = (path.basename(path.dirname(this.testPath)) === 'known_issues') ||
      (await Promise.all(UNEXPECTED_FAILURES.map((failure) => {
        return samePath(this.testPath, path.join(NODE_REPO_PATH, failure))
      }))).some(same => same) ||
      TRACING_HEADERS.some(header => {
        return this.stderr.includes(header)
      })
    return this
  }
  errorMessage () {
    let message = ''
    message += `Test agent reponse code ${this.statusCode}\n`
    for (const line of this.response.split('\n')) {
      message += `|    ${line}\n`
    }
    message += `Test output: rc ${this.rc}\n`
    for (const line of this.stderr.split('\n')) {
      message += `|    ${line}\n`
    }
    return message
  }
}

async function main () {
  let exitCode = 1
  try {
    const { version, major } = await nodeVersion(NODE_BIN)
    console.log(`Running tests for node ${version}`)
    if (major !== (await nodeRepoVersion(NODE_REPO_PATH)).major) {
      throw new Error('The Node repo isn\'t at the same version  as the binary')
    }
    if (NEEDS_TO_SPAWN_AGENT) {
      console.log('Start docker agent')
      await startTestAgent()
      await sleep(5000)
    }
    const tests = await listJsTests(NODE_REPO_PATH)
    tests.sort(({ testPath }, { testPath2 }) => {
      return testPath === testPath2 ? 0 : testPath > testPath2 ? 1 : -1
    })
    const testsByModule = {}
    for (const { moduleName, testPath } of tests) {
      if (testsByModule[moduleName] === undefined) {
        testsByModule[moduleName] = []
      }
      testsByModule[moduleName].push(testPath)
    }

    console.log('Running following tests:')
    for (const module in testsByModule) {
      console.log(`\t${module} : ${testsByModule[module].length} tests`)
    }

    const results = []
    for (const module in testsByModule) {
      results.push(...await runModuleTests(module, testsByModule[module]))
    }
    const shouldFail = results.some(r => !r.isPass && !r.isIgnore)
    if (!shouldFail) {
      exitCode = 0
    }
  } catch (e) {
    console.error('Fatal: ', e, e.stack)
  } finally {
    if (NEEDS_TO_SPAWN_AGENT) {
      console.log('Stop docker agent')
      try {
        await stopTestAgent()
      } catch (e) {
        console.error(`Failed to stop docker agent: ${e}`)
      }
    }
  }
  process.exit(exitCode)
}

main()
