'use strict'

/* eslint-disable no-console */

const axios = require('axios')
const checksum = require('checksum')
const fs = require('fs')
const mkdirp = require('mkdirp')
const os = require('os')
const path = require('path')
const tar = require('tar')
const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Downloading and compiling files for release.`)

if (!process.env.CIRCLE_TOKEN) {
  throw new Error([
    'The prepublish script needs to authenticate to CircleCI.',
    'Please set the CIRCLE_TOKEN environment variable.'
  ].join(' '))
}

const revision = exec.pipe(`git rev-parse HEAD`)

console.log(revision)

const branch = exec.pipe(`git symbolic-ref --short HEAD`)

console.log(branch)

const platforms = [
  'darwin-ia32',
  'darwin-x64',
  'linux-ia32',
  'linux-x64',
  'win32-ia32',
  'win32-x64'
]

const client = axios.create({
  baseURL: 'https://circleci.com/api/v2/',
  timeout: 5000,
  headers: {
    'Circle-Token': process.env.CIRCLE_TOKEN
  }
})

const fetch = (url, options) => {
  console.log(`GET ${url}`)

  return client.get(url, options)
    .catch(() => client.get(url, options))
    .catch(() => client.get(url, options))
}

getPipeline()
  .then(getWorkflow)
  .then(getPrebuildsJob)
  .then(getPrebuildArtifacts)
  .then(downloadArtifacts)
  .then(zipPrebuilds)
  .then(copyPrebuilds)
  .then(extractPrebuilds)
  .then(validatePrebuilds)
  .then(bundle)
  .catch(e => {
    process.exitCode = 1
    console.error(e)
  })

function getPipeline () {
  return fetch(`project/github/DataDog/dd-trace-js/pipeline?branch=${branch}`)
    .then(response => {
      const pipeline = response.data.items
        .find(item => item.vcs.revision === revision)

      if (!pipeline) {
        throw new Error(`Unable to find CircleCI pipeline for ${branch}@${revision}.`)
      }

      return pipeline
    })
}

function getWorkflow (pipeline) {
  return fetch(`pipeline/${pipeline.id}/workflow`)
    .then(response => {
      const workflows = response.data.items
        .sort((a, b) => (a.stopped_at < b.stopped_at) ? 1 : -1)
      const running = workflows.find(workflow => !workflow.stopped_at)

      if (running) {
        throw new Error(`Workflow ${running.id} is still running for pipeline ${pipeline.id}.`)
      }

      const workflow = workflows[0]

      if (!workflow) {
        throw new Error(`Unable to find CircleCI workflow for pipeline ${pipeline.id}.`)
      }

      if (workflow.status !== 'success') {
        throw new Error(`Aborting because CircleCI workflow ${workflow.id} did not succeed.`)
      }

      return workflow
    })
}

function getPrebuildsJob (workflow) {
  return fetch(`workflow/${workflow.id}/job`)
    .then(response => {
      const job = response.data.items
        .find(item => item.name === 'prebuilds')

      if (!job) {
        throw new Error(`Missing prebuild jobs in workflow ${workflow.id}.`)
      }

      return job
    })
}

function getPrebuildArtifacts (job) {
  return fetch(`project/github/DataDog/dd-trace-js/${job.job_number}/artifacts`)
    .then(response => {
      const artifacts = response.data.items
        .filter(artifact => /\/prebuilds\//.test(artifact.url))

      if (artifacts.length === 0) {
        throw new Error(`Missing artifacts in job ${job.job_number}.`)
      }

      return artifacts
    })
}

function downloadArtifacts (artifacts) {
  const files = artifacts.map(artifact => artifact.url)

  return Promise.all([
    Promise.all(files.map(downloadArtifact)),
    Promise.all(files.map(file => downloadArtifact(`${file}.sha1`)))
  ])
}

function downloadArtifact (file) {
  return fetch(file, { responseType: 'stream' })
    .then(response => {
      const parts = file.split('/')
      const basename = path.join(os.tmpdir(), parts.slice(-3, -1).join(path.sep))
      const filename = parts.slice(-1)[0]

      mkdirp.sync(basename)

      return new Promise((resolve, reject) => {
        response.data.pipe(fs.createWriteStream(path.join(basename, filename)))
          .on('finish', () => resolve())
          .on('error', reject)
      })
    })
}

function zipPrebuilds () {
  platforms.forEach(platform => {
    tar.create({
      gzip: true,
      sync: true,
      portable: true,
      strict: true,
      file: path.join(os.tmpdir(), `addons-${platform}.tgz`),
      cwd: os.tmpdir()
    }, [`prebuilds/${platform}`])
  })
}

function copyPrebuilds () {
  const basename = path.normalize(path.join(__dirname, '..'))

  platforms
    .map(platform => `addons-${platform}.tgz`)
    .forEach(filename => {
      fs.copyFileSync(
        path.join(os.tmpdir(), filename),
        path.join(basename, filename)
      )
    })
}

function extractPrebuilds () {
  platforms.forEach(platform => {
    tar.extract({
      sync: true,
      strict: true,
      file: `addons-${platform}.tgz`
    })
  })
}

function validatePrebuilds () {
  platforms.forEach(platform => {
    fs.readdirSync(path.join('prebuilds', platform))
      .filter(file => /^node-\d+\.node$/.test(file))
      .forEach(file => {
        const content = fs.readFileSync(path.join('prebuilds', platform, file))
        const sum = fs.readFileSync(path.join('prebuilds', platform, `${file}.sha1`), 'ascii')

        if (sum !== checksum(content)) {
          throw new Error(`Invalid checksum for "prebuilds/${platform}/${file}".`)
        }
      })
  })
}

function bundle () {
  exec('yarn bundle')
}
