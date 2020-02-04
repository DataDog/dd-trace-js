'use strict'

/* eslint-disable no-console */

const { spawn, fork } = require('child_process')
const { promisify } = require('util')
const { stat } = require('fs')
const { get: _get } = require('http')
const path = require('path')
const mongoService = require('../../packages/dd-trace/test/setup/services/mongo')
const autocannon = require('autocannon')

function cd (dir) {
  console.log('> cd', dir)
  process.chdir(dir)
}

function delay (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

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
    console.log('>> PID', subProcess.pid)
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
    execArgv: process.execArgv.concat(['--require', '../datadog.js'])
  })

  const customers = await get('http://localhost:9080/rest/api/config/countCustomers')

  if (parseInt(customers) < 10000) {
    console.log('# populating db')
    await get('http://localhost:9080/rest/api/loader/load?numCustomers=10000')
  }

  subProcess.kill()
  cd(__dirname)
}

async function ensureAppIsInstalled () {
  cd(__dirname)
  if (!(await exists(path.join(__dirname, 'acmeair-nodejs')))) {
    await sh('git clone git@github.com:acmeair/acmeair-nodejs.git')
  }
  if (!(await exists(path.join(__dirname, 'acmeair-nodejs', 'node_modules')))) {
    cd('acmeair-nodejs')
    await sh('npm install')
    cd(__dirname)
  }
}

function runTest (url, duration) {
  return autocannon({ url, duration })
}

async function testBoth (url, duration, prof) {
  cd(__dirname)
  const { subProcess: agentProcess } = await forkProcess('./fake-agent.js')
  cd('acmeair-nodejs')
  const execArgv = ['--require', '../datadog.js']
  if (prof) {
    execArgv.unshift('--prof')
  }
  const { subProcess: airProcess } = await forkProcess('./app.js', {
    execArgv: execArgv.concat(process.execArgv),
    env: Object.assign({}, process.env, { DD_ENABLE: '1' })
  })

  await delay(2000)

  const resultWithTracer = await runTest(url, duration)

  airProcess.kill()
  agentProcess.kill()

  const { subProcess: airProcess2 } = await forkProcess('./app.js', {
    execArgv: execArgv.concat(process.execArgv)
  })

  const resultWithoutTracer = await runTest(url, duration)

  airProcess2.kill()

  const { subProcess: airProcess3 } = await forkProcess('./app.js', {
    execArgv: execArgv.concat(process.execArgv),
    env: Object.assign({}, process.env, { ASYNC_HOOKS: '1' })
  })

  const resultWithAsyncHooks = await runTest(url, duration)

  airProcess3.kill()

  console.log(`>>>>>> RESULTS FOR ${url} RUNNING FOR ${duration} SECONDS`)

  logResult(resultWithoutTracer, resultWithAsyncHooks, resultWithTracer, 'requests')
  logResult(resultWithoutTracer, resultWithAsyncHooks, resultWithTracer, 'latency')
  logResult(resultWithoutTracer, resultWithAsyncHooks, resultWithTracer, 'throughput')

  console.log(`<<<<<< RESULTS FOR ${url} RUNNING FOR ${duration} SECONDS`)
}

function pad (str, num) {
  return Array(num - String(str).length).fill(' ').join('') + str
}

function logResult (resultWithoutTracer, resultWithAsyncHooks, resultWithTracer, type) {
  console.log(`\n${type.toUpperCase()}:`)
  console.log(`                  without tracer        with async_hooks             with tracer`)
  for (const name in resultWithoutTracer[type]) {
    console.log(
      pad(name, 7),
      `\t${pad(resultWithoutTracer[type][name], 16)}`,
      `\t${pad(resultWithAsyncHooks[type][name], 16)}`,
      `\t${pad(resultWithTracer[type][name], 16)}`
    )
  }
}

async function main () {
  const duration = process.env.DURATION ? parseInt(process.env.DURATION) : 10
  const prof = !!process.env.PROF
  await ensureAppIsInstalled()
  console.log('# checking that mongo is alive')
  await mongoService()
  console.log('# it is alive')
  await checkDb()
  await testBoth('http://localhost:9080/', duration, prof)
  await testBoth('http://localhost:9080/rest/api/config/countCustomers', duration, prof)
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
