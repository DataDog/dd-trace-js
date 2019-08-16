'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')

function clone (repo, localDir, branch, options) {
  if (typeof branch !== 'string') {
    options = branch
    branch = undefined
  }

  if (fs.existsSync(localDir)) {
    return execSync(`git -C '${localDir}' fetch --depth 1`, options)
  } else {
    const branchArgs = branch ? `-b ${branch}` : ''
    return execSync(`git clone --depth 1 --single-branch ${repo} ${branchArgs} '${localDir}'`, options)
  }
}

module.exports = {
  clone
}
