#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

const semver = require('semver')
const packageJson = require('../package.json')
const path = require('path')
const { execSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')

function helpAndExit () {
  console.log('usage: node prepare-release-proposal.js <action>')
  console.log('Actions:')
  console.log('  create-branch  Create a branch for the release proposal')
  console.log('  commit-branch-diffs  Commit the branch diffs to the release proposal branch')
  console.log('  update-package-json  Update the package.json version to the release proposal version')
  console.log('  help           Show this help message and exit')
  process.exit()
}

function createReleaseBranch (args) {
  if (typeof args === 'string') {
    const newVersion = semver.inc(packageJson.version, args)
    const branchName = `v${newVersion}-proposal`
    execSync(`git checkout -b ${branchName}`, { stdio: 'ignore' })

    console.log(branchName)
    return
  }

  switch (args[0]) {
    case 'minor':
    case 'patch':
      createReleaseBranch(args[0])
      break
    case 'help':
    default:
      console.log('usage: node prepare-release-proposal.js create-branch <version-type>')
      console.log('Version types:')
      console.log('  minor  Create a branch for a minor release proposal')
      console.log('  patch  Create a branch for a patch release proposal')
      break
  }
}

function commitBranchDiffs (args) {
  if (args.length !== 2) {
    console.log('usage: node prepare-release-proposal.js commit-branch-diffs <release-branch> <release-type>')
    console.log('release-branches:')
    console.log('  v4.x')
    console.log('  v5.x')
    console.log('release-types:')
    console.log('  minor')
    console.log('  patch')
    return
  }
  const releaseBranch = args[0]
  const releaseType = args[1]

  const excludedLabels = [
    'semver-major',
    `dont-land-on-${releaseBranch}`
  ]
  if (releaseType === 'patch') {
    excludedLabels.push('semver-minor')
  }

  const commandCore = `branch-diff --user DataDog --repo test-node-release-rebase \
--exclude-label=${excludedLabels.join(',')}`

  const releaseNotesDraft = execSync(`${commandCore} ${releaseBranch} master`).toString()

  execSync(`${commandCore} --format=sha --reverse ${releaseBranch} master | xargs git cherry-pick`)

  console.log(releaseNotesDraft)
}

function updatePackageJson (args) {
  if (args.length !== 1) {
    console.log('usage: node prepare-release-proposal.js update-package-json <release-type>')
    console.log('  minor')
    console.log('  patch')
    return
  }

  const newVersion = semver.inc(packageJson.version, args[0])
  const packageJsonPath = path.join(__dirname, '..', 'package.json')

  const packageJsonString = readFileSync(packageJsonPath).toString()
    .replace(`"version": "${packageJson.version}"`, `"version": "${newVersion}"`)

  writeFileSync(packageJsonPath, packageJsonString)

  console.log(newVersion)
}

const methodArgs = process.argv.slice(3)
switch (process.argv[2]) {
  case 'create-branch':
    createReleaseBranch(methodArgs)
    break
  case 'commit-branch-diffs':
    commitBranchDiffs(methodArgs)
    break
  case 'update-package-json':
    updatePackageJson(methodArgs)
    break
  case 'help':
  default:
    helpAndExit()
    break
}
