'use strict'

/* eslint-disable no-console */

const { spawn, fork } = require('child_process')
const { promisify } = require('util')
const { stat } = require('fs')
const { get: _get } = require('http')
const path = require('path')
const mongoService = require('../../packages/dd-trace/test/setup/services/mongo')
const autocannon = require('autocannon')
const { chdir: cd } = process

const preambleArgs = ['--require', '../preamble.js']

function sh (cmd) {
  return new Promise((resolve, reject) => {
    console.log('>', cmd)
    spawn(cmd, [], { stdio: 'inherit', shell: true })
      .on('error', reject)
      .on('close', resolve)
  })
}

function forkProcess (file, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`> node ${options.execArgv ? options.execArgv.join(' ') + ' ' : ''}${file}`)
    options.stdio = 'pipe'
    const subProcess = fork(file, options)
    console.log('## PID', subProcess.pid)
    subProcess.on('message', message => {
      if (message.ready) {
        resolve({ subProcess })
      }
    })
  })
}

const statAsync = promisify(stat)
async function exists (filename) {
  try {
    const stats = await statAsync(filename)
    return stats.isDirectory() || stats.isFile()
  } catch (e) {
    return false
  }
}

function get (url) {
  return new Promise((resolve, reject) => {
    _get(url, res => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString())
      })
    })
  })
}

async function checkDb () {
  console.log('# checking that db is populated')
  cd('acmeair-nodejs')
  const { subProcess } = await forkProcess('./app.js', {
    execArgv: process.execArgv.concat(preambleArgs)
  })

  const customers = await get('http://localhost:9080/rest/api/config/countCustomers')

  if (parseInt(customers) < 10000) {
    console.log('# populating db')
    await get('http://localhost:9080/rest/api/loader/load?numCustomers=10000')
  }

  subProcess.kill()
  cd(__dirname)
  console.log('# db is populated')
}

async function ensureAppIsInstalled () {
  cd(__dirname)
  if (!(await exists(path.join(__dirname, 'acmeair-nodejs')))) {
    await sh('git clone git@github.com:acmeair/acmeair-nodejs.git')
  }
  cd('acmeair-nodejs')
  await sh('npm install')
  cd(__dirname)
}

async function testOneScenario (url, duration, prof, additionalEnv = {}) {
  const execArgv = preambleArgs.slice()
  if (prof) {
    execArgv.unshift('--prof')
  }
  const { subProcess } = await forkProcess('./app.js', {
    execArgv: execArgv.concat(process.execArgv),
    env: Object.assign({}, process.env, additionalEnv)
  })

  const results = await autocannon({ url, duration })

  subProcess.kill()
  return results
}

async function withFakeAgent (fn) {
  console.log('# Starting fake agent')
  const { subProcess } = await forkProcess('../fake-agent.js')
  await fn()
  subProcess.kill()
}

async function testBoth ({ url, duration, prof, testAsyncHooks, appDir }) {
  // TODO We should have ways of invoking the individual tests in isolation
  cd(path.join(__dirname, appDir))
  const results = {}
  await withFakeAgent(async () => {
    console.log(' # Running with the tracer ...')
    results.withTracer = await testOneScenario(url, duration, prof, { DD_BENCH_TRACE_ENABLE: 1 })
  })

  console.log('# Running without the tracer (control) ...')
  results.withoutTracer = await testOneScenario(url, duration, prof)

  if (testAsyncHooks) {
    console.log('# Running with async_hooks ...')
    results.withAsyncHooks = await testOneScenario(url, duration, prof, { DD_BENCH_ASYNC_HOOKS: 1 })
  }

  console.log(`>>>>>> RESULTS FOR ${url} RUNNING FOR ${duration} SECONDS`)

  logResult(results, 'requests', testAsyncHooks)
  logResult(results, 'latency', testAsyncHooks)
  logResult(results, 'throughput', testAsyncHooks)

  console.log('\n\nSUMMARY:')
  console.log(
    'avg latency overhead %',
    (results.withTracer.latency.average / results.withoutTracer.latency.average - 1) * 100
  )
  console.log(
    'avg requests overhead %',
    (results.withoutTracer.requests.average / results.withTracer.requests.average - 1) * 100
  )
  console.log(
    'avg throughput overhead %',
    (results.withoutTracer.throughput.average / results.withTracer.throughput.average - 1) * 100
  )

  console.log(`\n<<<<<< RESULTS FOR ${url} RUNNING FOR ${duration} SECONDS`)
  cd(__dirname)
}

function pad (str, num) {
  return Array(num - String(str).length).fill(' ').join('') + str
}

function logResult (results, type, testAsyncHooks) {
  console.log(`\n${type.toUpperCase()}:`)
  if (testAsyncHooks) {
    console.log('                  without tracer        with async_hooks             with tracer')
    for (const name in results.withoutTracer[type]) {
      console.log(
        pad(name, 7),
        `\t${pad(results.withoutTracer[type][name], 16)}`,
        `\t${pad(results.withAsyncHooks[type][name], 16)}`,
        `\t${pad(results.withTracer[type][name], 16)}`
      )
    }
  } else {
    console.log('                  without tracer             with tracer')
    for (const name in results.withoutTracer[type]) {
      console.log(
        pad(name, 7),
        `\t${pad(results.withoutTracer[type][name], 16)}`,
        `\t${pad(results.withTracer[type][name], 16)}`
      )
    }
  }
}

function getOpts () {
  const argv = process.argv.slice(2)
  const opts = {
    duration: 10,
    url: 'http://localhost:9080/rest/api/config/countCustomers',
    appDir: 'acmeair-nodejs'
  }
  for (const arg of argv) {
    if (arg === '--prof') {
      opts.prof = true
    } else if (arg === '--async_hooks') {
      opts.testAsyncHooks = true
    } else if (arg.startsWith('--duration=')) {
      opts.duration = Number(arg.substr(11))
    } else if (arg.startsWith('--appdir=')) {
      opts.appDir = arg.substr(9)
    } else {
      opts.url = arg
    }
  }
  return opts
}

async function main () {
  await ensureAppIsInstalled()
  console.log('# checking that mongo is alive')
  await mongoService()
  console.log('# it is alive')
  await checkDb()
  await testBoth(getOpts())
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
