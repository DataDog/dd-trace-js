const semver = require('semver')
const { execSync } = require('child_process')

function uploadJUnitXMLReport () {
  if (semver.lt(process.version, '10.24.1')) {
    return
  }
  // we install @datadog/datadog-ci
  execSync('yarn add --dev @datadog/datadog-ci@0.13.0')
  // we execute the upload command
  execSync('yarn junit:upload')
}

uploadJUnitXMLReport()
