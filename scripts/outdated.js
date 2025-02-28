/* eslint-disable no-console */
const {
    getInternals,
    npmView
  } = require('./helpers/versioning')
  const path = require('path')
  const fs = require('fs')
  
  const latestsPath = path.join(
    __dirname,
    '..',
    'packages',
    'datadog-instrumentations',
    'src',
    'helpers',
    'latests.json'
  )
  
  // Get internal package names from existing getInternals helper
  const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
    .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))
  
  // Initial structure with placeholder for pinned packages
  const initialStructure = {
    pinned: ['ENTER_PACKAGE_NAME_HERE'],
    latests: {}
  }
  
  /**
     * Updates latests.json with the current latest versions from npm
     */
  async function fix () {
    console.log('Starting fix operation...')
    console.log(`Found ${internalsNames.length} packages to process`)
  
    let outputData = initialStructure
    if (fs.existsSync(latestsPath)) {
      console.log('Found existing latests.json, loading it...')
      outputData = require(latestsPath)
    }
  
    const latests = {}
    let processed = 0
    const total = internalsNames.length
  
    for (const name of internalsNames) {
      processed++
      process.stdout.write(`Processing package ${processed}/${total}: ${name}...`)
  
      try {
        const distTags = await npmView(name + ' dist-tags')
        const latest = distTags.latest
        if (latest) {
          latests[name] = latest
          process.stdout.write(` found version ${latest}\n`)
        } else {
          process.stdout.write(' WARNING: no version found\n')
          console.log(`Warning: Could not fetch latest version for "${name}"`)
        }
      } catch (error) {
        process.stdout.write(' ERROR\n')
        console.error(`Error fetching version for "${name}":`, error.message)
      }
    }
  
    outputData.latests = latests
    console.log('\nWriting updated versions to latests.json...')
    fs.writeFileSync(latestsPath, JSON.stringify(outputData, null, 2))
    console.log('Successfully updated latests.json')
    console.log(`Processed ${total} packages`)
  }
  
  /**
     * Checks if latests.json matches current npm versions
     */
  async function check () {
    console.log('Starting version check...')
  
    if (!fs.existsSync(latestsPath)) {
      console.log('latests.json does not exist. Run with "fix" to create it.')
      process.exitCode = 1
      return
    }
  
    const currentData = require(latestsPath)
    console.log(`Found ${internalsNames.length} packages to check`)
  
    let processed = 0
    let mismatches = 0
    const total = internalsNames.length
  
    for (const name of internalsNames) {
      processed++
      process.stdout.write(`Checking package ${processed}/${total}: ${name}...`)
  
      const latest = currentData.latests[name]
      if (!latest) {
        process.stdout.write(' MISSING\n')
        console.log(`No latest version found for "${name}"`)
        process.exitCode = 1
        continue
      }
  
      try {
        const distTags = await npmView(name + ' dist-tags')
        const npmLatest = distTags.latest
        if (npmLatest !== latest) {
          process.stdout.write(' MISMATCH\n')
          console.log(`"latests.json: is not up to date for "${name}": expected "${npmLatest}", got "${latest}"`)
          process.exitCode = 1
          mismatches++
        } else {
          process.stdout.write(' OK\n')
        }
      } catch (error) {
        process.stdout.write(' ERROR\n')
        console.error(`Error checking version for "${name}":`, error.message)
      }
    }
  
    console.log('\nCheck completed:')
    console.log(`- Total packages checked: ${total}`)
    console.log(`- Version mismatches found: ${mismatches}`)
    if (mismatches > 0) {
      console.log('Run with "fix" to update versions')
    }
  }
  if (process.argv.includes('fix')) fix()
  else check()