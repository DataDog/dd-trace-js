/* eslint-disable no-console */

const childProcess = require('child_process')
const ORIGIN = 'origin/'

let releaseBranch = process.env['GITHUB_BASE_REF'] // 'origin/v3.x'
let releaseVersion = releaseBranch
if (releaseBranch.startsWith(ORIGIN)) {
  releaseVersion = releaseBranch.substring(ORIGIN.length)
} else {
  releaseBranch = ORIGIN + releaseBranch
}
let currentBranch = process.env['GITHUB_HEAD_REF'] // 'ugaitz/workflow-to-verify-dont-land-on-v3.x'
if (!currentBranch.startsWith(ORIGIN)) {
  currentBranch = ORIGIN + currentBranch
}

const getHashesCommandWithExclusions = 'branch-diff --user DataDog --repo dd-trace-js --exclude-label=semver-major' +
  ` --exclude-label=dont-land-on-${releaseVersion} ${releaseBranch} ${currentBranch}`
const getHashesCommandWithoutExclusions =
  `branch-diff --user DataDog --repo dd-trace-js ${releaseBranch} ${currentBranch}`

childProcess.exec(getHashesCommandWithExclusions, { timeout: 30000 },
  (withExclusionError, withExclusionStdout, withExclusionStderr) => {
    if (withExclusionError) {
      console.error(`stdout:
${withExclusionStdout}
stderr:
${withExclusionStderr}
`, withExclusionError)
      process.exit(1)
      return
    }
    if (withExclusionStderr) {
      console.error(withExclusionStderr)
      process.exit(1)
      return
    }
    const commitsHashesWithExclusions = withExclusionStdout.split('\n')

    childProcess.exec(getHashesCommandWithoutExclusions,
      (withoutExclusionError, withoutExclusionStdout, withoutExclusionStderr) => {
        if (withoutExclusionError) {
          console.error(`stdout:
${withoutExclusionStdout}
stderr:
${withoutExclusionStderr}
`, withoutExclusionError)
          process.exit(1)
          return
        }
        if (withoutExclusionStderr) {
          console.error(withoutExclusionStderr)
          process.exit(1)
          return
        }
        const commitsHashesWithoutExclusions = withoutExclusionStdout.split('\n')
        if (commitsHashesWithExclusions.length !== commitsHashesWithoutExclusions.length) {
          const commitsWithInvalidLabels = []
          commitsHashesWithoutExclusions.filter(c1 => {
            if (!commitsHashesWithExclusions.some(c2 => c2 === c1)) {
              commitsWithInvalidLabels.push(c1)
            }
          })
          console.error('Some excluded label added in the release proposal', commitsWithInvalidLabels)
          process.exit(1)
        } else {
          console.log('Commit PRs label looks OK')
        }
      })
  })
