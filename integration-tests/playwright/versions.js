'use strict'

const { DD_MAJOR } = require('../../version')

// Increment when the Dockerfile changes to force a fresh image build in GHCR.
const dockerBuild = 2

const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const latest = require('../../packages/dd-trace/test/plugins/versions/package.json')
  .dependencies['@playwright/test']

const tag = (version) => `${version}-${dockerBuild}`

module.exports = { oldest, latest, tag }
