'use strict'

const fs = require('fs').promises
const path = require('path')
const { execSync } = require('child_process')

/**
 * Version Manager for Integration Scaffolding
 * Automatically updates dd-trace versions package.json when scaffolding new integrations
 */
class VersionManager {
  constructor (options = {}) {
    this.ddTraceRoot = options.ddTraceRoot || path.join(__dirname, '../../../../../..')
    this.versionsPackageJsonPath = path.join(this.ddTraceRoot, 'packages/dd-trace/test/plugins/versions/package.json')
    this.verbose = options.verbose || false
  }

  async ensurePackageInVersions (packageName) {
    try {
      const packageJsonContent = await fs.readFile(this.versionsPackageJsonPath, 'utf8')
      const packageJson = JSON.parse(packageJsonContent)

      if (packageJson.dependencies[packageName]) {
        if (this.verbose) {
          console.log(`📦 Package ${packageName} already exists in versions package.json`)
        }
        return packageJson.dependencies[packageName]
      }

      if (this.verbose) {
        console.log(`📦 Adding ${packageName} to versions package.json...`)
      }

      const latestVersion = await this.getLatestVersion(packageName)
      packageJson.dependencies[packageName] = latestVersion

      // Sort dependencies alphabetically
      const sortedDependencies = {}
      Object.keys(packageJson.dependencies)
        .sort()
        .forEach(key => {
          sortedDependencies[key] = packageJson.dependencies[key]
        })

      packageJson.dependencies = sortedDependencies

      await fs.writeFile(
        this.versionsPackageJsonPath,
        JSON.stringify(packageJson, null, 2) + '\n'
      )

      if (this.verbose) {
        console.log(`✅ Added ${packageName}@${latestVersion} to versions package.json`)
      }

      return latestVersion
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Failed to update versions package.json for ${packageName}:`, error.message)
      }
      throw error
    }
  }

  async getLatestVersion (packageName) {
    try {
      const result = execSync(`npm view ${packageName} version`, { encoding: 'utf8' })
      return result.trim()
    } catch (error) {
      throw new Error(`Failed to get latest version for ${packageName}: ${error.message}`)
    }
  }

  async getVersionRecommendations (packageName, options = {}) {
    const maxVersionsPerMajor = options.maxVersionsPerMajor || 3
    const includeLatest = options.includeLatest !== false

    try {
      // Get all versions
      const versionsResult = execSync(`npm view ${packageName} versions --json`, { encoding: 'utf8' })
      const allVersions = JSON.parse(versionsResult)

      // Group by major version
      const versionsByMajor = {}
      allVersions.forEach(version => {
        const major = version.split('.')[0]
        if (!versionsByMajor[major]) {
          versionsByMajor[major] = []
        }
        versionsByMajor[major].push(version)
      })

      // Select representative versions from each major
      const recommendations = {}
      Object.keys(versionsByMajor).forEach(major => {
        const versions = versionsByMajor[major]
        const selected = []

        // Always include latest in major
        if (versions.length > 0) {
          selected.push(versions[versions.length - 1])
        }

        // Add some intermediate versions if there are many
        if (versions.length > maxVersionsPerMajor) {
          const step = Math.floor(versions.length / maxVersionsPerMajor)
          for (let i = step; i < versions.length - 1; i += step) {
            if (selected.length < maxVersionsPerMajor) {
              selected.push(versions[i])
            }
          }
        }

        recommendations[major] = selected.slice(0, maxVersionsPerMajor)
      })

      return recommendations
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Could not get version recommendations for ${packageName}:`, error.message)
      }
      // Fallback to just latest version
      const latest = await this.getLatestVersion(packageName)
      const major = latest.split('.')[0]
      return { [major]: [latest] }
    }
  }
}

module.exports = { VersionManager }
