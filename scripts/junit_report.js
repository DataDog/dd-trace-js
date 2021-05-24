/* eslint-disable no-console */

const semver = require('semver')
const { execSync } = require('child_process')

function uploadJUnitXMLReport () {
  if (semver.lt(process.version, '10.24.1')) {
    console.log('Node version incompatible with @datadog/datadog-ci. Skipping step.')
    return
  }
  if (process.env.CIRCLE_PR_NUMBER) {
    console.log('Running in a fork. Skipping step.')
    return
  }
  // we install @datadog/datadog-ci
  execSync('yarn add --dev @datadog/datadog-ci@0.13.0', { stdio: 'inherit' })
  // we execute the upload command
  execSync('yarn junit:upload',
    {
      stdio: 'inherit',
      env: { ...process.env, CI_NODE_VERSION: process.version }
    }
  )
}

uploadJUnitXMLReport()
