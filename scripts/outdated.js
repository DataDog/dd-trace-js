/* eslint-disable no-console */
'use strict'

const { getInternals } = require('./helpers/versioning')
const path = require('path')
const fs = require('fs')
const semver = require('semver')
const childProcess = require('child_process')

const latestsPath = path.join(
  __dirname,
  '..',
  'packages',
  'datadog-instrumentations',
  'src',
  'helpers',
  'latests.json'
)

const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
  .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))

// Packages that should be ignored during version checking - these won't be included in latests.json
const IGNORED_PACKAGES = [
  // Add package names here
  'aerospike', // I think this is due to architecture issues?
  'dd-trace-api', // unsure what this is - can't be found
  'mariadb', // mariadb esm tests were failing
  'microgateway-core', // 'microgateway-core' was failing to find a directory
  'winston' // winston esm tests were failing
]

// Packages that should be pinned to specific versions
const PINNED_PACKAGES = {
  // Example: 'express': '4.17.3'
  fastify: '4.28.1', // v5+ is not supported
  express: '4.21.2'
}

// Packages that should only use the 'latest' tag (not 'next' or other dist-tags)
// Some packages have a next tag that is a stable semver version
const ONLY_USE_LATEST_TAG = [
  // Example: 'router'
]

// Initial structure for latests.json that will be recreated each run
const outputData = {
  pinned: Object.keys(PINNED_PACKAGES),
  onlyUseLatestTag: ONLY_USE_LATEST_TAG,
  ignored: IGNORED_PACKAGES,
  latests: {}
}

function npmView (input) {
  return new Promise((resolve, reject) => {
    childProcess.exec(`npm view ${input} --json`, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      try {
        resolve(JSON.parse(stdout.toString('utf8')))
      } catch (e) {
        reject(new Error(`Failed to parse npm output for ${input}: ${e.message}`))
      }
    })
  })
}

async function getHighestCompatibleVersion (name) {
  try {
    if (IGNORED_PACKAGES.includes(name)) {
      console.log(`Skipping "${name}" as it's in the ignored list`)
      return null
    }

    // If package is hardcoded as pinned, return the pinned version but also check latest
    // this is for logging purposes
    if (PINNED_PACKAGES[name]) {
      const pinnedVersion = PINNED_PACKAGES[name]

      try {
        const distTags = await npmView(`${name} dist-tags`)
        const latestTagged = distTags.latest

        if (latestTagged && semver.gt(latestTagged, pinnedVersion)) {
          console.log(`Note: "${name}" is pinned to ${pinnedVersion}, but ${latestTagged} is available`)
        }
      } catch (err) {
        // Just log the error but continue with the pinned version
        console.log(`Warning: Could not fetch latest version for pinned package "${name}": ${err.message}`)
      }

      return pinnedVersion
    }

    // ideally we can just use `latest` tag, but a few use `next`
    const distTags = await npmView(`${name} dist-tags`)

    // Get the latest tagged version
    const latestTagged = distTags.latest

    if (!latestTagged) {
      console.log(`Warning: Could not fetch latest version for "${name}"`)
      return null
    }

    // If package is in the onlyUseLatestTag list, always use the 'latest' tag
    if (ONLY_USE_LATEST_TAG.includes(name)) {
      return latestTagged
    }

    // Get all available versions
    const allVersions = await npmView(`${name} versions`)

    // Find the highest non-prerelease version available
    const stableVersions = allVersions.filter(v => !semver.prerelease(v))
    const highestStableVersion = stableVersions.sort(semver.compare).pop()

    // Use the highest stable version if it's greater than the latest tag
    if (highestStableVersion && semver.gt(highestStableVersion, latestTagged)) {
      process.stdout.write(` found version ${highestStableVersion} (higher than 'latest' tag ${latestTagged})`)
      return highestStableVersion
    }

    return latestTagged
  } catch (error) {
    console.error(`Error fetching version for "${name}":`, error.message)
    return null
  }
}

async function fix () {
  console.log('Starting fix operation...')
  console.log(`Found ${internalsNames.length} packages to process`)

  const latests = {}
  let processed = 0
  const total = internalsNames.length

  for (const name of internalsNames) {
    processed++
    process.stdout.write(`Processing package ${processed}/${total}: ${name}...`)

    // Skip ignored packages
    if (IGNORED_PACKAGES.includes(name)) {
      process.stdout.write(' IGNORED\n')
      continue
    }

    try {
      // Handle hardcoded pinned packages
      if (PINNED_PACKAGES[name]) {
        const pinnedVersion = PINNED_PACKAGES[name]
        latests[name] = pinnedVersion
        process.stdout.write(` PINNED to version ${pinnedVersion}\n`)
        continue
      }

      // Normal package processing
      const latestVersion = await getHighestCompatibleVersion(name)
      if (latestVersion) {
        latests[name] = latestVersion
        process.stdout.write(` found version ${latestVersion}\n`)
      } else {
        process.stdout.write(' WARNING: no version found\n')
      }
    } catch (error) {
      process.stdout.write(' ERROR\n')
      console.error(`Error processing "${name}":`, error.message)
    }
  }

  // Update the output data
  outputData.latests = latests

  // Write the updated configuration with a comment at the top
  console.log('\nWriting updated versions to latests.json...')

  // Convert to JSON with proper indentation
  const jsonContent = JSON.stringify(outputData, null, 2)

  fs.writeFileSync(latestsPath, jsonContent)

  console.log('Successfully updated latests.json')
  console.log(`Processed ${total} packages`)
}

fix()
