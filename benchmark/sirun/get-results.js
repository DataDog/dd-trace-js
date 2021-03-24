'use strict'

const https = require('https')
const { execSync } = require('child_process')

const { CIRCLE_TOKEN } = process.env

const ref = process.argv.length > 2 ? process.arv[2] : 'HEAD'
const gitCommit = execSync(`git rev-parse ${ref}`).toString().trim()

const circleHeaders = CIRCLE_TOKEN ? {
  'circle-token': CIRCLE_TOKEN
} : {}

const statusUrl = ref =>
  `https://api.github.com/repos/DataDog/dd-trace-js/commits/${ref}/statuses?per_page=100`
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
  const results = JSON.parse(await get(statusUrl(ref)))
  const namesAndNums = {}
  for (const build of results.filter(s => s.context.includes('-sirun-'))) {
    const url = new URL(build.target_url)
    namesAndNums[build.context.replace('ci/circleci: ', '')] = url.pathname.split('/').pop()
  }
  return namesAndNums
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
      buildData[name][variant] = result
    }
  }
  // eslint-disable-next-line no-console
  console.log(require('util').inspect(buildData, false, null, true))
}

main()
