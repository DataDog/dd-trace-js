'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const basename = require('path').basename

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

function checkoutDefault (options) {
  const defaultBranch = execSync("git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'", options)
  return checkout(defaultBranch.toString().trim(), options)
}

function checkout (branch, options) {
  return execSync(`git checkout ${branch} --`, options)
}

module.exports = {
  cloneWithBranch,
  checkoutDefault,
  checkout
}
