'use strict'

const https = require('https')
const { execSync } = require('child_process')

const { CIRCLE_TOKEN } = process.env

const ref = process.argv.length > 2 ? process.argv[2] : 'HEAD'
const gitCommit = execSync(`git rev-parse ${ref}`).toString().trim()

const circleHeaders = CIRCLE_TOKEN ? {
  'circle-token': CIRCLE_TOKEN
} : {}

const statusUrl = (ref, page) =>
  `https://api.github.com/repos/DataDog/dd-trace-js/commits/${ref}/statuses?per_page=100&page=${page}`
const artifactsUrl = num =>
  `https://circleci.com/api/v1.1/project/github/DataDog/dd-trace-js/${num}/artifacts`

function get (url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: Object.assign({
      'user-agent': 'dd-results-retriever',
      accept: 'application/json'
    }, headers) }, async res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        resolve(get(res.headers.location))
        return
      }
      res.on('error', reject)
      let payload = ''
      for await (const chunk of res) {
        payload += chunk
      }
      resolve(payload)
    }).on('error', reject)
  })
}

async function getBuildNumsFromGithub (ref) {
  const results = []
  let page = 1
  let reply = JSON.parse(await get(statusUrl(ref, page)))
  results.push(...reply)
  while (reply.length === 100) {
    reply = JSON.parse(await get(statusUrl(ref, ++page)))
    results.push(...reply)
  }
  const namesAndNums = {}
  for (const build of results.filter(s => s.context.includes('-sirun-'))) {
    const url = new URL(build.target_url)
    namesAndNums[build.context.replace('ci/circleci: ', '')] = url.pathname.split('/').pop()
  }
  return namesAndNums
}

function mean (items) {
  const len = items.length
  const total = items.reduce((prev, cur) => prev + cur, 0)
  return total / len
}

function stddev (m, items) {
  return Math.sqrt(mean(items.map(x => (x - m) ** 2)))
}

function summary (iterations) {
  const stats = {}
  for (const iteration of iterations) {
    for (const [k, v] of Object.entries(iteration)) {
      if (!stats[k]) {
        stats[k] = []
      }
      stats[k].push(v)
    }
  }
  const result = {}
  for (const [name, items] of Object.entries(stats)) {
    const m = mean(items)
    const s = stddev(m, items)
    result[name] = { mean: m, stddev: s }
  }
  return result
}

async function main () {
  const builds = await getBuildNumsFromGithub(gitCommit)
  const buildData = {}
  for (const name in builds) {
    const artifacts = JSON.parse(await get(artifactsUrl(builds[name]), circleHeaders))
    const artifactUrl = artifacts.find(a => a.path === 'sirun-output.ndjson').url
    const testResults = (await get(artifactUrl, circleHeaders))
      .trim().split('\n').map(x => JSON.parse(x))
    for (const result of testResults) {
      const name = result.name
      const variant = result.variant
      if (!buildData[name]) {
        buildData[name] = {}
      }
      delete result.name
      delete result.variant
      if (result.iterations) {
        result.summary = summary(result.iterations)
      }
      delete result.iterations
      buildData[name][variant] = result
    }
  }
  // eslint-disable-next-line no-console
  console.log(require('util').inspect(buildData, false, null, true))
}

main()
