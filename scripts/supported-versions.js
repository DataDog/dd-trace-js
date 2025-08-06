/* eslint-disable @stylistic/js/max-len */
/* eslint-disable no-console */
'use strict'

const fs = require('fs')
const path = require('path')
const semver = require('semver')
const { getInternals, npmView } = require('./helpers/versioning')
const externals = require('../packages/dd-trace/test/plugins/externals')
const latests = require('../packages/datadog-instrumentations/src/helpers/latests.json')

// Output file path
const outputPath = path.join(__dirname, '..', 'integration-versions.csv')

// Process command line arguments
const args = process.argv.slice(2)
const filter = args.length > 0 ? args[0].split(',') : null

async function main () {
  // Generate entries directly from latests.json to ensure complete coverage
  const entries = generateEntriesFromLatests()

  // Also check instrumentations for min versions
  const instrumentationEntries = generateEntriesFromInstrumentations()

  // Merge the entries, prioritizing min versions from instrumentations
  mergeEntries(entries, instrumentationEntries)

  // Fetch latest versions from NPM for entries with 'unknown' max versions
  await fetchLatestVersions(entries)

  // Generate CSV from the combined entries
  let csvContent = 'integration_name,npm_name,min_version_tested,max_version_tested\n'

  // Sort entries alphabetically for consistency
  const sortedEntries = Array.from(entries.values()).sort((a, b) => {
    if (a.integrationName === b.integrationName) {
      return a.npmName.localeCompare(b.npmName)
    }
    return a.integrationName.localeCompare(b.integrationName)
  })

  // Add all entries to CSV
  for (const entry of sortedEntries) {
    csvContent += `${entry.integrationName},${entry.npmName},${entry.minVersion},${entry.maxVersion}\n`
    console.log(`  Added ${entry.npmName}: min=${entry.minVersion}, max=${entry.maxVersion}`)
  }

  // Write CSV to file
  fs.writeFileSync(outputPath, csvContent)

  // Generate summary
  console.log(`\nCSV file generated at: ${outputPath}`)
  console.log(`Total entries: ${entries.size}`)
  console.log(`Expected entries from latests.json: ${Object.keys(latests.latests).length}`)
}

function generateEntriesFromLatests () {
  console.log('Generating entries from latests.json...')
  const entries = new Map()

  // Get all instrumentation names from the instrumentations directory
  const names = fs.readdirSync(path.join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
    .filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))
    .sort()

  console.log(`Found ${names.length} instrumentations to process.`)

  // Create mapping of npm packages to integration names
  const packageToIntegrationMap = {}

  // First create a mapping of npm packages to integration names
  for (const integrationName of names) {
    // Simplest case - integration name is the same as npm package name
    if (latests.latests[integrationName]) {
      packageToIntegrationMap[integrationName] = integrationName
    }

    // Check instrumentations file for references to npm packages
    try {
      const filePath = path.join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src', `${integrationName}.js`)
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8')

        // Look for addHook patterns that reference npm packages
        const addHookRegex = /addHook\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/gs
        let match

        while ((match = addHookRegex.exec(fileContent)) !== null) {
          const npmName = match[1]
          if (latests.latests[npmName]) {
            packageToIntegrationMap[npmName] = integrationName
          }
        }
      }
    } catch (error) {
      console.error(`Error processing ${integrationName} for npm mapping:`, error)
    }
  }

  // Add entries from externals
  for (const integrationName in externals) {
    if (!filter || filter.includes(integrationName)) {
      for (const external of externals[integrationName]) {
        if (latests.latests[external.name]) {
          packageToIntegrationMap[external.name] = integrationName
        }
      }
    }
  }

  // Now add entries for all packages in latests.json
  for (const [npmName, maxVersion] of Object.entries(latests.latests)) {
    const integrationName = packageToIntegrationMap[npmName] || npmName

    // Create entry with unknown min version - we'll fill this in later
    entries.set(npmName, {
      integrationName,
      npmName,
      minVersion: 'unknown',
      maxVersion
    })
  }

  return entries
}

function generateEntriesFromInstrumentations () {
  console.log('Extracting minimum versions from instrumentations...')
  const entries = new Map()

  // Get all instrumentations
  const allInstrumentations = getInternals()

  // Also get external instrumentations
  for (const integrationName in externals) {
    if (!filter || filter.includes(integrationName)) {
      for (const external of externals[integrationName]) {
        if (external.versions && external.versions.length > 0) {
          allInstrumentations.push({
            name: external.name,
            integrationName,
            versions: external.versions
          })
        }
      }
    }
  }

  // Process each instrumentation to extract minimum versions
  for (const instrumentation of allInstrumentations) {
    const npmName = Array.isArray(instrumentation.name)
      ? instrumentation.name[0]
      : instrumentation.name

    const integrationName = instrumentation.integrationName || npmName

    if (!filter || filter.includes(integrationName)) {
      const versions = [].concat(instrumentation.versions || [])

      if (versions.length > 0) {
        // Extract minimum version from all version ranges
        const minVersion = extractMinVersion(npmName, versions)

        // Use the maximum version from latests.json
        const maxVersion = latests.latests[npmName] || 'unknown'

        entries.set(npmName, {
          integrationName,
          npmName,
          minVersion,
          maxVersion
        })
      }
    }
  }

  return entries
}

function extractMinVersion (npmName, versionRanges) {
  const extractedVersions = []

  for (const range of versionRanges) {
    if (range === '*') continue

    // Handle exact versions
    if (semver.valid(range)) {
      extractedVersions.push(range)
      continue
    }

    // Handle >= ranges
    const gteMatch = range.match(/>=\s*([0-9]+(\.[0-9]+(\.[0-9]+)?)?)/)
    if (gteMatch) {
      // Ensure full semver format
      let version = gteMatch[1]
      if (version.split('.').length === 1) version += '.0.0'
      if (version.split('.').length === 2) version += '.0'
      extractedVersions.push(version)
      continue
    }

    // Handle explicit version ranges like 2.x or ^3.0.0
    try {
      // For ranges like 2.x, try to convert to 2.0.0
      const simplifiedRange = range.replace(/(\d+)\.x/, '$1.0.0')
      if (semver.validRange(simplifiedRange)) {
        const minInRange = semver.minVersion(simplifiedRange)
        if (minInRange) {
          extractedVersions.push(minInRange.version)
        }
      }
    } catch (e) {
      // Skip invalid ranges
      console.log(`  Warning: Couldn't parse range "${range}" for ${npmName}`)
    }
  }

  // Find the minimum version among all extracted versions
  if (extractedVersions.length > 0) {
    return extractedVersions.reduce((min, current) => {
      return (semver.valid(current) && semver.valid(min) && semver.lt(current, min)) ? current : min
    }, extractedVersions[0])
  }

  return 'unknown'
}

function mergeEntries (targetEntries, sourceEntries) {
  for (const [npmName, sourceEntry] of sourceEntries.entries()) {
    if (targetEntries.has(npmName)) {
      const targetEntry = targetEntries.get(npmName)

      // Update min version if source has a valid one
      if (sourceEntry.minVersion !== 'unknown') {
        targetEntry.minVersion = sourceEntry.minVersion
      }

      // Integration name from source might be more specific
      if (targetEntry.integrationName === npmName && sourceEntry.integrationName !== npmName) {
        targetEntry.integrationName = sourceEntry.integrationName
      }
    } else {
      // Add source entry if it doesn't exist in target
      targetEntries.set(npmName, sourceEntry)
    }
  }
}

async function fetchLatestVersions (entries) {
  console.log('\nFetching latest versions from NPM for entries with "unknown" max version...')

  // Collect all packages that need to be updated
  const packagesToUpdate = Array.from(entries.values())
    .filter(entry => entry.maxVersion === 'unknown')

  if (packagesToUpdate.length === 0) {
    console.log('No entries with "unknown" max version found.')
    return
  }

  console.log(`Found ${packagesToUpdate.length} entries to update`)

  // Process packages in batches to avoid overloading the NPM registry
  const batchSize = 10
  for (let i = 0; i < packagesToUpdate.length; i += batchSize) {
    const batch = packagesToUpdate.slice(i, i + batchSize)

    // Process each package in the current batch in parallel
    await Promise.all(batch.map(async (entry) => {
      try {
        console.log(`  Fetching latest version for ${entry.npmName}...`)

        // Get latest version from npm registry
        const versions = await npmView(`${entry.npmName} versions`)
        if (!versions || versions.length === 0) {
          console.log(`  Warning: No versions found for ${entry.npmName}`)
          return
        }

        // Find the latest stable version (non-prerelease)
        const stableVersions = versions.filter(v => !semver.prerelease(v))
        if (stableVersions.length === 0) {
          console.log(`  Warning: No stable versions found for ${entry.npmName}`)
          return
        }

        const latestVersion = stableVersions.sort(semver.compare).pop()

        // Update the entry
        entry.maxVersion = latestVersion
        console.log(`  Updated ${entry.npmName} max version to ${latestVersion}`)
      } catch (error) {
        console.error(`  Error fetching version for ${entry.npmName}:`, error.message)
      }
    }))

    // Add a small delay between batches to avoid rate limiting
    if (i + batchSize < packagesToUpdate.length) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  console.log('Finished fetching latest versions from NPM')
}

// Run the main function
main().catch(error => {
  console.error('Error:', error)
  process.exit(1)
})
