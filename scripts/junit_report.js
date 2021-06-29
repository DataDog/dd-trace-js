/* eslint-disable no-console */

const { execSync } = require('child_process')

function uploadJUnitXMLReport () {
  if (process.env.CIRCLE_PR_NUMBER) {
    console.log('Running in a fork. Skipping step.')
    return
  }
  // we install @datadog/datadog-ci
  execSync('yarn global add @datadog/datadog-ci@0.13.2', { stdio: 'inherit' })
  const service = process.env.PLUGINS ? 'plugins' : 'core'
  // we execute the upload command
  execSync(
    `DD_ENV=ci datadog-ci junit upload \
    --tags runtime.version:${process.version} \
    --service dd-trace-js-${service}-tests \
    ./test-results/mocha/test-results.xml`,
    {
      stdio: 'inherit'
    }
  )
}

uploadJUnitXMLReport()
