'use strict'

/* eslint-disable no-console */

const autocannon = require('autocannon')
const axios = require('axios')
const chalk = require('chalk')
const getPort = require('get-port')
const Table = require('cli-table3')
const URL = require('url').URL
const { spawn } = require('child_process')

main()

async function main () {
  try {
    const disabled = await run(false)
    const enabled = await run(true)

    compare(disabled, enabled)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

async function run (profilerEnabled) {
  const port = await getPort()
  const url = new URL(`http://localhost:${port}/hello`)
  const server = await createServer(profilerEnabled, url)

  title(`Benchmark (enabled=${profilerEnabled})`)

  await getUsage(url)

  const net = await benchmark(url.href, 15000)
  const cpu = await getUsage(url)

  server.kill('SIGINT')

  return { cpu, net }
}

function benchmark (url, maxConnectionRequests) {
  return new Promise((resolve, reject) => {
    const duration = maxConnectionRequests * 2 / 1000
    const instance = autocannon({ duration, maxConnectionRequests, url }, (err, result) => {
      err ? reject(err) : resolve(result)
    })

    process.once('SIGINT', () => {
      instance.stop()
    })

    autocannon.track(instance, {
      renderResultsTable: true,
      renderProgressBar: false
    })
  })
}

function compare (result1, result2) {
  title('Comparison (disabled VS enabled)')

  compareNet(result1.net, result2.net)
  compareCpu(result1.cpu, result2.cpu)
}

function compareNet (result1, result2) {
  const shortLatency = new Table({
    head: asColor(chalk.cyan, ['Stat', '2.5%', '50%', '97.5%', '99%', 'Avg', 'Max'])
  })

  shortLatency.push(asLowRow(chalk.bold('Latency'), asDiff(result1.latency, result2.latency)))

  console.log(shortLatency.toString())

  const requests = new Table({
    head: asColor(chalk.cyan, ['Stat', '1%', '2.5%', '50%', '97.5%', 'Avg', 'Min'])
  })

  requests.push(asHighRow(chalk.bold('Req/Sec'), asDiff(result1.requests, result2.requests, true)))
  requests.push(asHighRow(chalk.bold('Bytes/Sec'), asDiff(result1.throughput, result2.throughput, true)))

  console.log(requests.toString())
}

function compareCpu (result1, result2) {
  const cpuTime = new Table({
    head: asColor(chalk.cyan, ['Stat', 'User', 'System', 'Process'])
  })

  cpuTime.push(asTimeRow(chalk.bold('CPU Time'), asDiff(result1, result2)))

  console.log(cpuTime.toString())
}

function waitOn ({ interval = 250, timeout, resources }) {
  return Promise.all(resources.map(resource => {
    return new Promise((resolve, reject) => {
      let intervalTimer
      const timeoutTimer = timeout && setTimeout(() => {
        reject(new Error('Timeout.'))
        clearTimeout(timeoutTimer)
        clearTimeout(intervalTimer)
      }, timeout)

      function waitOnResource () {
        if (timeout && !timeoutTimer) return

        axios.get(resource)
          .then(() => {
            resolve()
            clearTimeout(timeoutTimer)
            clearTimeout(intervalTimer)
          })
          .catch(() => {
            intervalTimer = setTimeout(waitOnResource, interval)
          })
      }

      waitOnResource()
    })
  }))
}

async function createServer (profilerEnabled, url) {
  const server = spawn(process.execPath, ['server'], {
    cwd: __dirname,
    env: {
      DD_PROFILING_ENABLED: String(profilerEnabled),
      PORT: url.port
    }
  })

  process.once('SIGINT', () => {
    server.kill('SIGINT')
  })

  await waitOn({
    timeout: 5000,
    resources: [url.href]
  })

  return server
}

async function getUsage (url) {
  const response = await axios.get(`${url.origin}/usage`)
  const usage = response.data

  usage.process = usage.user + usage.system

  return usage
}

function asColor (colorise, row) {
  return row.map((entry) => colorise(entry))
}

function asDiff (stat1, stat2, reverse = false) {
  const result = Object.create(null)

  Object.keys(stat1).forEach((k) => {
    if (stat2[k] === stat1[k]) return (result[k] = '0%')
    if (stat1[k] === 0) return (result[k] = '+∞%')
    if (stat2[k] === 0) return (result[k] = '-∞%')

    const fraction = stat2[k] / stat1[k]
    const percent = Math.round(fraction * 100) - 100
    const value = `${withSign(percent)}%`

    if (percent > 0) {
      result[k] = reverse ? chalk.green(value) : chalk.red(value)
    } else if (percent < 0) {
      result[k] = reverse ? chalk.red(value) : chalk.green(value)
    } else {
      result[k] = value
    }
  })

  return result
}

function asLowRow (name, stat) {
  return [
    name,
    stat.p2_5,
    stat.p50,
    stat.p97_5,
    stat.p99,
    stat.average,
    typeof stat.max === 'string' ? stat.max : Math.floor(stat.max * 100) / 100
  ]
}

function asHighRow (name, stat) {
  return [
    name,
    stat.p1,
    stat.p2_5,
    stat.p50,
    stat.p97_5,
    stat.average,
    typeof stat.min === 'string' ? stat.min : Math.floor(stat.min * 100) / 100
  ]
}

function asTimeRow (name, stat) {
  return [
    name,
    stat.user,
    stat.system,
    stat.process
  ]
}

function withSign (value) {
  return value < 0 ? `${value}` : `+${value}`
}

function title (str) {
  const line = ''.padStart(str.length, '=')

  console.log('')
  console.log(line)
  console.log(str)
  console.log(line)
  console.log('')
}
