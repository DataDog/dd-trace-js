'use strict'

/* eslint-disable no-console */

const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
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
  'darwin-x32',
  'darwin-x64',
  'linux-x32',
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
}

getPipeline()
  .then(getWorkflowId)
  .then(getWorkflow)
  .then(getPrebuildJobs)
  .then(downloadPrebuilds)
  .then(copyPrebuilds)
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

function getWorkflowId (pipeline) {
  return fetch(`pipeline/${pipeline.id}`)
    .then(response => {
      const workflow = response.data.workflows[0]

      if (!workflow) {
        throw new Error(`Unable to find CircleCI workflow for pipeline ${workflow.id}.`)
      }

      return workflow.id
    })
}

function getWorkflow (id) {
  return fetch(`workflow/${id}`)
    .then(response => {
      const workflow = response.data

      if (workflow.status !== 'success') {
        throw new Error(`Aborting because CircleCI workflow ${workflow.id} did not succeed.`)
      }

      return workflow
    })
}

function getPrebuildJobs (workflow) {
  const filter = platforms.map(platform => `prebuild-${platform}`)

  return fetch(`workflow/${workflow.id}/jobs`)
    .then(response => {
      const jobs = response.data.items
        .filter(item => ~filter.indexOf(item.name))

      if (jobs.length < 6) {
        throw new Error(`Missing prebuild jobs in workflow ${workflow.id}.`)
      }

      return jobs
    })
}

function downloadPrebuilds (jobs) {
  return Promise.all(jobs.map(job => {
    return getPrebuildArtifacts(job)
      .then(downloadArtifacts)
  }))
}

function getPrebuildArtifacts (job) {
  const filter = platforms.map(platform => `addons-${platform}.tgz`)

  return fetch(`project/github/DataDog/dd-trace-js/${job.job_number}/artifacts`)
    .then(response => {
      return response.data.items
        .filter(artifact => filter.some(file => artifact.url.endsWith(file)))
    })
}

function downloadArtifacts (artifacts) {
  return Promise.all(artifacts.map(downloadArtifact))
}

function downloadArtifact (artifact) {
  return fetch(artifact.url, { responseType: 'stream' })
    .then(response => {
      const filename = /[^/]*$/.exec(artifact.url)[0]

      return new Promise((resolve, reject) => {
        response.data.pipe(fs.createWriteStream(path.join(os.tmpdir(), filename)))
          .on('finish', () => resolve())
          .on('error', reject)
      })
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

function bundle () {
  exec('yarn bundle')
}
