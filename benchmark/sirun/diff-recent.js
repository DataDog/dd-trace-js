'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execSync } = require('child_process')

const { CIRCLE_TOKEN, GITHUB_TOKEN } = process.env

const statusUrl = (ref, page) =>
  `https://api.github.com/repos/DataDog/dd-trace-js/commits/${ref}/statuses?per_page=100&page=${page}`
const artifactsUrl = num =>
  `https://circleci.com/api/v1.1/project/github/DataDog/dd-trace-js/${num}/artifacts`

const circleHeaders = CIRCLE_TOKEN ? {
  'circle-token': CIRCLE_TOKEN
} : {}

const githubHeaders = GITHUB_TOKEN ? {
  Authorization: `token ${GITHUB_TOKEN}`
} : {}

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
  let page = 0
  let reply
  do {
    reply = JSON.parse(await get(statusUrl(ref, ++page), githubHeaders))
    results.push(...reply)
  } while (reply.length === 100)
  const namesAndNums = {}
  for (const build of results.filter(s => s.context.includes('-sirun-'))) {
    const url = new URL(build.target_url)
    namesAndNums[build.context.replace('ci/circleci: ', '')] = url.pathname.split('/').pop()
  }
  return namesAndNums
}

function walk (tree, oldTree) {
  if (typeof tree === 'number') {
    const diff = tree - oldTree
    const pctDiff = 100 * diff / oldTree
    return pctDiff
  }

  if (typeof tree === 'object') {
    const result = {}
    for (const name in tree) {
      if (name in oldTree) {
        result[name] = walk(tree[name], oldTree[name])
      }
    }
    return result
  }

  throw new Error(tree.toString())
}

(async () => {
  const prev = execSync('git rev-parse HEAD^').toString().trim()
  const builds = await getBuildNumsFromGithub(prev)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]

  const artifacts = JSON.parse(await get(artifactsUrl(build), circleHeaders))
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))
  if (!artifact) return
  const prevSummary = JSON.parse(await get(artifact.url, circleHeaders))
  const currentSummary = JSON.parse(fs.readFileSync('/tmp/artifacts/summary.json'))

  const diffTree = walk(currentSummary, prevSummary)

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(diffTree, null, 2))

  const html = fs.readFileSync(path.join(__dirname, 'diff.html'), 'utf8')
  fs.writeFileSync('/tmp/artifacts/diff.html', html.replace('REPLACE_ME_DIFF_DATA', JSON.stringify(diffTree, null, 2)))
})()
