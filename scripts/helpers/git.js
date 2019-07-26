'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')

function cloneWithBranch (repo, localDir, branch, options) {
  if (typeof branch !== 'string') {
    options = branch
    branch = undefined
  }

  const branchArgs = branch ? `-b ${branch}` : ''

  if (fs.existsSync(localDir)) {
    return execSync(`git -C '${localDir}' fetch --depth 1`, options)
  }
  return execSync(`git clone --depth 1 --single-branch ${repo} ${branchArgs} '${localDir}'`, options)
}

module.exports = {
  cloneWithBranch
}
