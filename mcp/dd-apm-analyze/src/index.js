'use strict'
/* eslint-disable no-console */

const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const https = require('https')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const { fetchAndExtract } = require('./fetcher')
const { analyzePackage } = require('./parser')
const { adjustScores } = require('./judge')
const { judgeWithLLM } = require('./judge_llm')
const { scoreDataAvailability, getSupportedTypes } = require('./data_requirements')
const { scoreDataAvailability: genericScoreDataAvailability } = require('../../shared/examples/analyzer-integration')

// NPM Registry API integration
async function fetchNpmMetadata (packageName) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`)
    if (!response.ok) {
      console.warn(`Failed to fetch NPM metadata for ${packageName}: ${response.status}`)
      return null
    }
    const data = await response.json()
    return {
      homepage: data.homepage,
      repository: data.repository,
      description: data.description,
      keywords: data.keywords || [],
      readme: data.readme, // Often more comprehensive than package README
      versions: Object.keys(data.versions || {}),
      latestVersion: data['dist-tags']?.latest
    }
  } catch (error) {
    console.warn(`Error fetching NPM metadata for ${packageName}:`, error.message)
    return null
  }
}

// Version range management
function determineSupportedVersions (packageInfo) {
  const versions = Object.keys(packageInfo.versions || {})
  const now = new Date()
  const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())

  // Group versions by major
  const versionsByMajor = {}
  const supportedVersions = []

  for (const version of versions) {
    try {
      const versionInfo = packageInfo.versions[version]
      const publishDate = new Date(packageInfo.time[version])

      // Skip versions older than 2 years
      if (publishDate < twoYearsAgo) continue

      const major = version.split('.')[0]
      if (!versionsByMajor[major]) {
        versionsByMajor[major] = []
      }

      versionsByMajor[major].push({
        version,
        publishDate,
        info: versionInfo
      })
    } catch (error) {
      // Skip invalid versions
      continue
    }
  }

  // Select representative versions for each major
  for (const major of Object.keys(versionsByMajor).sort()) {
    const majorVersions = versionsByMajor[major].sort((a, b) => b.publishDate - a.publishDate)

    // Always include the latest version of each major
    supportedVersions.push({
      version: majorVersions[0].version,
      major,
      role: 'latest',
      publishDate: majorVersions[0].publishDate
    })

    // Include the earliest supported version if different
    const earliest = majorVersions[majorVersions.length - 1]
    if (earliest.version !== majorVersions[0].version) {
      supportedVersions.push({
        version: earliest.version,
        major,
        role: 'earliest',
        publishDate: earliest.publishDate
      })
    }

    // Include a middle version if there are many versions
    if (majorVersions.length > 3) {
      const middleIndex = Math.floor(majorVersions.length / 2)
      const middle = majorVersions[middleIndex]
      supportedVersions.push({
        version: middle.version,
        major,
        role: 'representative',
        publishDate: middle.publishDate
      })
    }
  }

  return supportedVersions
}

async function analyzeVersionDifferences (packageName, versions) {
  const versionAnalyses = {}
  const apiDifferences = []

  console.log(`Analyzing ${versions.length} versions for API differences...`)

  for (const versionInfo of versions) {
    try {
      console.log(`  Analyzing ${packageName}@${versionInfo.version}...`)

      // Download and analyze each version
      const tempDir = await fetchAndExtract(packageName, versionInfo.version)
      const packageRoot = await findPackageRoot(tempDir, packageName)
      const analysis = await analyzePackage(packageRoot)

      versionAnalyses[versionInfo.version] = {
        ...analysis,
        versionInfo
      }

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn(`  Failed to analyze ${packageName}@${versionInfo.version}: ${error.message}`)

      // Try to clean up temp directory even on error
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      continue
    }
  }

  // Compare versions to detect API differences
  const versionKeys = Object.keys(versionAnalyses).sort()

  for (let i = 1; i < versionKeys.length; i++) {
    const prevVersion = versionKeys[i - 1]
    const currVersion = versionKeys[i]

    const prevTargets = versionAnalyses[prevVersion].targets || []
    const currTargets = versionAnalyses[currVersion].targets || []

    const prevMethods = new Set(prevTargets.map(t => `${t.module}:${t.function_name}`))
    const currMethods = new Set(currTargets.map(t => `${t.module}:${t.function_name}`))

    // Detect removed methods
    for (const method of prevMethods) {
      if (!currMethods.has(method)) {
        apiDifferences.push({
          type: 'removed',
          method,
          fromVersion: prevVersion,
          toVersion: currVersion,
          impact: 'breaking'
        })
      }
    }

    // Detect added methods
    for (const method of currMethods) {
      if (!prevMethods.has(method)) {
        apiDifferences.push({
          type: 'added',
          method,
          fromVersion: prevVersion,
          toVersion: currVersion,
          impact: 'feature'
        })
      }
    }

    // Detect signature changes (simplified)
    for (const method of prevMethods) {
      if (currMethods.has(method)) {
        const prevTarget = prevTargets.find(t => `${t.module}:${t.function_name}` === method)
        const currTarget = currTargets.find(t => `${t.module}:${t.function_name}` === method)

        if (prevTarget && currTarget && prevTarget.module !== currTarget.module) {
          apiDifferences.push({
            type: 'moved',
            method,
            fromVersion: prevVersion,
            toVersion: currVersion,
            fromModule: prevTarget.module,
            toModule: currTarget.module,
            impact: 'breaking'
          })
        }
      }
    }
  }

  return { versionAnalyses, apiDifferences }
}

async function findPackageRoot (extractedDir, packageName) {
  const possiblePaths = []

  // Pattern 1: Direct extraction - package.json in root
  possiblePaths.push(extractedDir)

  // Pattern 2: Named directory with version - packageName-version/
  try {
    const entries = await fs.readdir(extractedDir)
    for (const entry of entries) {
      const entryPath = path.join(extractedDir, entry)
      const stat = await fs.stat(entryPath)
      if (stat.isDirectory()) {
        // Check if directory name starts with package name
        if (entry.startsWith(packageName.replace('@', '').replace('/', '-'))) {
          possiblePaths.push(entryPath)
        }
        // Check if it's a generic 'package' directory
        if (entry === 'package') {
          possiblePaths.push(entryPath)
        }
        // For scoped packages, check for @scope-name pattern
        if (packageName.includes('/') && entry.includes('-')) {
          const scopedPattern = packageName.replace('@', '').replace('/', '-')
          if (entry.startsWith(scopedPattern)) {
            possiblePaths.push(entryPath)
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Could not read directory ${extractedDir}:`, error.message)
  }

  // Check each possible path for package.json
  for (const possiblePath of possiblePaths) {
    try {
      const packageJsonPath = path.join(possiblePath, 'package.json')
      await fs.access(packageJsonPath)

      // Verify it's the right package by checking the name
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
      if (packageJson.name === packageName) {
        console.log(`  Found package root: ${possiblePath}`)
        return possiblePath
      }
    } catch (error) {
      // Continue checking other paths
      continue
    }
  }

  // Fallback: return the first directory that has any package.json
  for (const possiblePath of possiblePaths) {
    try {
      const packageJsonPath = path.join(possiblePath, 'package.json')
      await fs.access(packageJsonPath)
      console.warn(`  Using fallback package root (name mismatch): ${possiblePath}`)
      return possiblePath
    } catch (error) {
      continue
    }
  }

  throw new Error(`Could not find package.json for ${packageName} in ${extractedDir}`)
}

function detectSubcategory (category, pkgName, targets, docSignals) {
  const targetMethods = targets.map(t => t.function_name?.toLowerCase()).filter(Boolean)
  const keywords = (docSignals.keywords || []).map(k => k.toLowerCase())
  const description = (docSignals.description || '').toLowerCase()
  const packageName = pkgName.toLowerCase()

  switch (category) {
    case 'http':
      return detectHttpSubcategory(packageName, targetMethods, keywords, description)
    case 'database':
      return detectDatabaseSubcategory(packageName, targetMethods, keywords, description)
    case 'messaging':
      return detectMessagingSubcategory(packageName, targetMethods, keywords, description)
    case 'cache':
      return detectCacheSubcategory(packageName, targetMethods, keywords, description)
    default:
      return null
  }
}

function detectHttpSubcategory (packageName, targetMethods, keywords, description) {
  // Client indicators
  const clientMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'request', 'fetch']
  const clientKeywords = ['client', 'request', 'fetch', 'ajax', 'api']
  const clientPackages = ['axios', 'got', 'superagent', 'node-fetch', 'undici']

  // Server indicators
  const serverMethods = ['listen', 'use', 'route', 'app', 'router', 'middleware', 'handle', 'createserver']
  const serverKeywords = ['server', 'framework', 'web', 'express', 'koa', 'fastify', 'hapi']
  const serverPackages = ['express', 'koa', 'fastify', 'hapi', 'restify']

  const hasClientMethods = clientMethods.some(method => targetMethods.includes(method))
  const hasClientKeywords = clientKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))
  const isClientPackage = clientPackages.some(pkg => packageName.includes(pkg))

  const hasServerMethods = serverMethods.some(method => targetMethods.includes(method))
  const hasServerKeywords = serverKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))
  const isServerPackage = serverPackages.some(pkg => packageName.includes(pkg))

  // Score client vs server indicators
  const clientScore = (hasClientMethods ? 2 : 0) + (hasClientKeywords ? 1 : 0) + (isClientPackage ? 2 : 0)
  const serverScore = (hasServerMethods ? 2 : 0) + (hasServerKeywords ? 1 : 0) + (isServerPackage ? 2 : 0)

  if (clientScore > serverScore && clientScore > 0) return 'client'
  if (serverScore > clientScore && serverScore > 0) return 'server'

  // Default to client for ambiguous HTTP packages
  return 'client'
}

function detectDatabaseSubcategory (packageName, targetMethods, keywords, description) {
  // Most database packages are clients, but some could be servers
  const serverKeywords = ['server', 'daemon', 'engine']
  const hasServerKeywords = serverKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))

  return hasServerKeywords ? 'server' : 'client'
}

function detectMessagingSubcategory (packageName, targetMethods, keywords, description) {
  // Producer indicators
  const producerMethods = ['publish', 'send', 'produce', 'emit', 'push', 'enqueue', 'add']
  const producerKeywords = ['producer', 'publisher', 'sender']

  // Consumer indicators
  const consumerMethods = ['subscribe', 'consume', 'receive', 'on', 'process', 'listen', 'run']
  const consumerKeywords = ['consumer', 'subscriber', 'listener', 'worker']

  const hasProducerMethods = producerMethods.some(method => targetMethods.includes(method))
  const hasProducerKeywords = producerKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))

  const hasConsumerMethods = consumerMethods.some(method => targetMethods.includes(method))
  const hasConsumerKeywords = consumerKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))

  // Many messaging libraries support both, so we'll return the dominant pattern
  const producerScore = (hasProducerMethods ? 2 : 0) + (hasProducerKeywords ? 1 : 0)
  const consumerScore = (hasConsumerMethods ? 2 : 0) + (hasConsumerKeywords ? 1 : 0)

  if (producerScore > consumerScore && producerScore > 0) return 'producer'
  if (consumerScore > producerScore && consumerScore > 0) return 'consumer'

  // Default to client for ambiguous messaging packages
  return 'client'
}

function detectCacheSubcategory (packageName, targetMethods, keywords, description) {
  // Most cache packages are clients
  const serverKeywords = ['server', 'daemon', 'engine', 'standalone']
  const hasServerKeywords = serverKeywords.some(keyword => keywords.includes(keyword) || description.includes(keyword))

  return hasServerKeywords ? 'server' : 'client'
}

// Enhanced documentation fetcher using NPM metadata
async function fetchEnhancedDocumentation (packageName, npmMetadata) {
  const docs = { readme: '', homepage: '', repository: '' }

  if (!npmMetadata) return docs

  // Use NPM registry README if available (often better than package README)
  if (npmMetadata.readme) {
    docs.readme = npmMetadata.readme
  }

  // Try to fetch documentation from homepage
  if (npmMetadata.homepage) {
    try {
      const response = await fetch(npmMetadata.homepage, {
        timeout: 5000,
        headers: { 'User-Agent': 'dd-apm-analyze/1.0.0' }
      })
      if (response.ok) {
        const content = await response.text()
        // Extract useful content (basic HTML parsing)
        const codeBlocks = content.match(/```[\s\S]*?```/g) || []
        docs.homepage = codeBlocks.join('\n\n')
      }
    } catch (error) {
      console.warn(`Could not fetch homepage documentation: ${error.message}`)
    }
  }

  // Try to fetch better README from GitHub if repository is available
  if (npmMetadata.repository?.url) {
    const repoUrl = npmMetadata.repository.url
    const githubMatch = repoUrl.match(/github\.com[/:]([\w-]+)\/([\w-]+)/)
    if (githubMatch) {
      const [, owner, repo] = githubMatch
      try {
        const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`
        const response = await fetch(readmeUrl, { timeout: 5000 })
        if (response.ok) {
          docs.repository = await response.text()
        } else {
          // Try main branch
          const mainReadmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`
          const mainResponse = await fetch(mainReadmeUrl, { timeout: 5000 })
          if (mainResponse.ok) {
            docs.repository = await mainResponse.text()
          }
        }
      } catch (error) {
        console.warn(`Could not fetch GitHub README: ${error.message}`)
      }
    }
  }

  return docs
}

yargs(hideBin(process.argv))
  .command('analyze <pkg>', 'Analyze a package to find instrumentation targets', (yargs) => {
    return yargs
      .positional('pkg', {
        describe: 'Package to analyze (e.g., redis@^4.0.0)',
        type: 'string'
      })
      .option('output', {
        alias: 'o',
        describe: 'Path to save the JSON analysis report',
        type: 'string'
      })
      .option('minScore', {
        describe: 'Minimum confidence score to include',
        type: 'number',
        default: 0
      })
      .option('maxPerExport', {
        describe: 'Maximum targets per export group',
        type: 'number',
        default: 20
      })
      .option('maxTotal', {
        describe: 'Maximum total targets to include',
        type: 'number',
        default: 200
      })
      .option('llm', {
        describe: 'Enable LLM judge pruning (requires OPENAI_API_KEY)',
        type: 'boolean',
        default: false
      })
      .option('enhance', {
        describe: 'Enable LLM enhancement for empty fields with code verification',
        type: 'boolean',
        default: false
      })
      .option('multi-version', {
        describe: 'Analyze multiple versions (2 years back to current) for API differences',
        type: 'boolean',
        default: false
      })
      .option('interactive', {
        describe: 'Enable interactive category prompting when LLM is uncertain',
        type: 'boolean',
        default: true
      })
      .option('assist', {
        describe: 'Run LLM assistant after analysis and include notes in report',
        type: 'boolean',
        default: true
      })
      .option('data-scoring', {
        describe: 'Enable data requirements scoring to prioritize functions with span-relevant data',
        type: 'boolean',
        default: true
      })
  }, async (argv) => {
    try {
      const extractedPath = await fetchAndExtract(argv.pkg)
      let targets = await analyzePackage(extractedPath)
      // Handle scoped packages properly (e.g., @nestjs/core)
      const pkgName = argv.pkg.startsWith('@') ? argv.pkg : argv.pkg.split('@')[0]

      // Fetch enhanced documentation from NPM registry
      console.log(`Fetching NPM metadata for ${pkgName}...`)
      const npmMetadata = await fetchNpmMetadata(pkgName)
      const enhancedDocs = await fetchEnhancedDocumentation(pkgName, npmMetadata)

      const docSignals = await extractDocSignals(extractedPath, pkgName, npmMetadata)

      // Multi-version analysis if requested
      let versionAnalysis = null
      if (argv.multiVersion && npmMetadata) {
        console.log('🔍 Multi-version analysis enabled...')

        // Fetch full package metadata with version history
        const fullMetadata = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`)
          .then(res => res.json())
          .catch(() => null)

        if (fullMetadata) {
          const supportedVersions = determineSupportedVersions(fullMetadata)
          console.log(`📦 Found ${supportedVersions.length} versions to analyze across ${new Set(supportedVersions.map(v => v.major)).size} major versions`)

          if (supportedVersions.length > 1) {
            versionAnalysis = await analyzeVersionDifferences(pkgName, supportedVersions)
            console.log(`✅ Version analysis complete: ${Object.keys(versionAnalysis.versionAnalyses).length} versions analyzed, ${versionAnalysis.apiDifferences.length} API differences detected`)
          }
        }
      }

      // Use LLM for category detection with heuristic fallback
      let category = 'other'
      let subcategory = null
      let llmCategoryResult = null

      if (argv.enhance && (process.env.DD_AI_GATEWAY || process.env.OPENAI_API_KEY)) {
        llmCategoryResult = await detectCategoryWithLLM(pkgName, targets, docSignals, enhancedDocs)
        if (llmCategoryResult && llmCategoryResult.confidence >= 0.7) {
          category = llmCategoryResult.category
        } else {
          // LLM uncertain, use heuristic as backup and prompt user
          const heuristicCategory = detectCategory(pkgName, targets, docSignals)
          if (argv.interactive && process.stdin.isTTY) {
            category = await promptUserForCategory(pkgName, llmCategoryResult, heuristicCategory)
          } else {
            // Non-interactive mode, use LLM result or heuristic
            category = llmCategoryResult?.category || heuristicCategory
            console.log(`Non-interactive mode: Using ${llmCategoryResult ? 'LLM' : 'heuristic'} category: ${category}`)
          }
        }
      } else {
        // No LLM available, use heuristic
        category = detectCategory(pkgName, targets, docSignals)
        console.log(`Using heuristic category detection: ${category}`)
      }

      // Detect subcategory based on the main category
      subcategory = detectSubcategory(category, pkgName, targets, docSignals)
      if (subcategory) {
        console.log(`Detected subcategory: ${category}-${subcategory}`)
      }

      let docExamples = await extractDocExamples(extractedPath, pkgName, category, targets, docSignals, enhancedDocs, subcategory)
      // Clean up semicolons and fix variable hoisting
      docExamples = cleanupTestExamples(docExamples)
      targets = await adjustScores(extractedPath, pkgName, targets)

      // Apply data requirements scoring if enabled and subcategory is supported
      if (argv.dataScoring && subcategory && getSupportedTypes().includes(`${category}-${subcategory}`)) {
        console.log(`Applying data requirements scoring for ${category}-${subcategory}...`)
        targets = targets.map(target => {
          // Use generic scoring system for better consistency with test agents
          const dataScore = genericScoreDataAvailability(target, category, subcategory)

          // Enhanced scoring algorithm that prioritizes data availability
          const originalScore = target.confidence_score || 0
          const dataAvailability = dataScore.score || 0

          // Dynamic weighting based on data availability
          let dataWeight, originalWeight
          if (dataAvailability >= 0.8) {
            // High data availability: favor data-rich targets
            dataWeight = 0.7
            originalWeight = 0.3
          } else if (dataAvailability >= 0.5) {
            // Medium data availability: balanced approach
            dataWeight = 0.5
            originalWeight = 0.5
          } else if (dataAvailability >= 0.3) {
            // Low data availability: still consider but reduce impact
            dataWeight = 0.3
            originalWeight = 0.7
          } else {
            // Very low data availability: heavily penalize
            dataWeight = 0.2
            originalWeight = 0.8
          }

          // Base combined score
          let combinedScore = (originalScore * originalWeight) + (dataAvailability * dataWeight)

          // Apply bonuses and penalties
          if (dataAvailability >= 0.8) {
            // Bonus for targets with excellent data availability
            combinedScore = Math.min(1.0, combinedScore * 1.15)
          } else if (dataAvailability < 0.2) {
            // Penalty for targets with very poor data availability
            combinedScore = combinedScore * 0.7
          }

          // Calculate data completeness score (how much critical/important data is available)
          const criticalData = dataScore.breakdown.critical || {}
          const importantData = dataScore.breakdown.important || {}

          const criticalAvailable = Object.values(criticalData).filter(d => d.available).length
          const criticalTotal = Object.keys(criticalData).length
          const importantAvailable = Object.values(importantData).filter(d => d.available).length
          const importantTotal = Object.keys(importantData).length

          const criticalCompleteness = criticalTotal > 0 ? criticalAvailable / criticalTotal : 1
          const importantCompleteness = importantTotal > 0 ? importantAvailable / importantTotal : 1
          const overallCompleteness = (criticalCompleteness * 0.8) + (importantCompleteness * 0.2)

          return {
            ...target,
            confidence_score: combinedScore,
            data_score: dataScore.score,
            data_availability: dataScore.dataAvailability,
            data_reasoning: dataScore.reasoning,
            original_score: originalScore,
            scoring_details: {
              data_weight: dataWeight,
              original_weight: originalWeight,
              critical_completeness: criticalCompleteness,
              important_completeness: importantCompleteness,
              overall_completeness: overallCompleteness,
              bonus_applied: dataAvailability >= 0.8,
              penalty_applied: dataAvailability < 0.2
            },
            data_requirements: {
              integrationType: dataScore.integrationType,
              breakdown: dataScore.breakdown,
              expectedSpanFields: dataScore.expectedSpanFields
            }
          }
        })

        // Re-sort by new combined scores
        targets.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
        console.log(`  Enhanced ${targets.length} targets with data requirements scoring`)

        // Log top targets with detailed scoring
        if (targets.length > 0) {
          console.log('  Top targets by enhanced scoring:')
          targets.slice(0, 3).forEach((target, index) => {
            const details = target.scoring_details || {}
            console.log(`    ${index + 1}. ${target.function_name} (${target.file_path})`)
            console.log(`       Final Score: ${(target.confidence_score * 100).toFixed(1)}% (orig: ${(target.original_score * 100).toFixed(1)}%, data: ${(target.data_score * 100).toFixed(1)}%)`)
            console.log(`       Data Completeness: Critical ${(details.critical_completeness * 100).toFixed(0)}%, Important ${(details.important_completeness * 100).toFixed(0)}%`)
            console.log(`       Weighting: ${(details.data_weight * 100).toFixed(0)}% data, ${(details.original_weight * 100).toFixed(0)}% original${details.bonus_applied ? ' (bonus applied)' : ''}${details.penalty_applied ? ' (penalty applied)' : ''}`)
          })
        }
      } else {
        console.log(`  Skipping data requirements scoring - ${category}-${subcategory} not supported`)
      }

      // Canonicalize paths and apply size filters
      targets = canonicalizeAndFilterTargets(extractedPath, targets, {
        minScore: argv.minScore,
        maxPerExport: argv.maxPerExport,
        maxTotal: argv.maxTotal,
        category,
        docSignals
      })

      // Derive metadata for scaffolding
      const capabilities = inferCapabilities(targets, category)
      let similarIntegration = suggestSimilarIntegration(category)
      let finalDocExamples = docExamples

      if (argv.llm) {
        targets = await judgeWithLLM(extractedPath, pkgName, targets, { maxTotal: argv.maxTotal, useLLM: true })
      }

      // LLM fallback for empty or inadequate fields with code verification
      if (argv.enhance && (process.env.DD_AI_GATEWAY || process.env.OPENAI_API_KEY)) {
        const enhancedFields = await enhanceAnalysisWithLLM(pkgName, category, targets, finalDocExamples, similarIntegration, enhancedDocs, extractedPath)
        finalDocExamples = enhancedFields.docExamples || finalDocExamples
        similarIntegration = enhancedFields.similarIntegration || similarIntegration
      }

      // Detect bundling to emit a cautionary note for instrumentation feasibility
      const cautions = await detectBundledArtifacts(extractedPath)

      // Optional assistant guidance (also triggers if no targets)
      let assistantNotes = ''
      if (argv.assist || (targets && targets.length === 0)) {
        const topTargets = (targets || [])
          .slice(0, 8)
          .map(t => ({ export: t.export_name, method: t.function_name }))
        const summary = {
          library_name: pkgName,
          category,
          capabilities,
          similar_integration: similarIntegration,
          cautions,
          targets_count: (targets || []).length,
          top_targets: topTargets
        }
        const system = 'You are an APM instrumentation assistant. Be concise.'
        const promptLines = [
          'Advise on:',
          '- Correct category if misclassified (explain briefly).',
          '- What to instrument (public hooks vs underlying driver).',
          '- If targets are empty, why and what to do instead.',
          '- External services to use in CI (only if certain).',
          'Summary follows as JSON:'
        ]
        const user = promptLines.join('\n') + '\n' + JSON.stringify(summary)
        assistantNotes = await askLLM(system, user)
        if (assistantNotes) {
          console.log('\nAssistant notes:\n' + assistantNotes + '\n')
        }
      }

      if (argv.output) {
        await writeReport(argv.pkg, targets, argv.output, {
          category,
          subcategory,
          capabilities,
          similar_integration: similarIntegration,
          docs_signals: docSignals,
          test_examples: finalDocExamples,
          cautions,
          assistant_notes: assistantNotes,
          version_analysis: versionAnalysis
        })
        console.log(`Analysis report saved to: ${argv.output}`)
      } else {
        printReport(targets)
      }
    } catch (e) {
      console.error('An error occurred:', e.message)
      process.exit(1)
    }
  })
  .command(require('./mine_keywords'))
  .command('assist <question>', 'Ask an LLM assistant about a package, using optional analysis context', (y) => {
    return y
      .positional('question', { describe: 'Question to ask', type: 'string' })
      .option('context', { alias: 'c', describe: 'Path to an analysis JSON report to include as context', type: 'string' })
      .option('web', { describe: 'Include brief web search context', type: 'boolean', default: false })
  }, async (argv) => {
    try {
      let contextText = ''
      let pkgName = ''
      if (argv.context) {
        try {
          const raw = await fs.readFile(path.resolve(argv.context), 'utf8')
          const json = JSON.parse(raw)
          pkgName = json.library_name || ''
          const summary = {
            library_name: json.library_name,
            category: json.category,
            capabilities: json.capabilities,
            cautions: json.cautions,
            docs_signals: json.docs_signals,
            targets_sample: (json.targets || []).slice(0, 10)
          }
          contextText = `Context (from analysis report):\n${JSON.stringify(summary, null, 2)}`
        } catch {}
      }

      let webText = ''
      if (argv.web && typeof fetch === 'function') {
        try {
          const q = encodeURIComponent(`${pkgName ? pkgName + ' ' : ''}${argv.question}`)
          const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`)
          if (res.ok) {
            const data = await res.json()
            const topics = (data.RelatedTopics || []).slice(0, 5).map(t => t.Text || t.Result).filter(Boolean)
            if (topics.length) webText = `\nWeb hints:\n- ${topics.join('\n- ')}`
          }
        } catch {}
      }

      const system = 'You are an APM instrumentation assistant. Answer concisely and pragmatically.'
      const user = `${contextText}\n${webText}\n\nQuestion: ${argv.question}`
      const answer = await askLLM(system, user)
      console.log(answer || 'No answer produced (missing OPENAI_API_KEY?)')
    } catch (e) {
      console.error('Assist failed:', e.message)
      process.exit(1)
    }
  })
  .demandCommand(1)
  .parse()

function printReport (targets) {
  console.log('\nFound potential instrumentation targets:')
  if (targets.length === 0) {
    console.log('  - None found.')
  } else {
    targets.forEach(target => {
      const name = target.export_name === 'default'
        ? target.function_name
        : `${target.export_name}.${target.function_name}`
      console.log(`  - [${target.type}] ${name} in ${target.file_path} (Confidence: ${target.confidence_score * 100}%)`)
      console.log(`    Reason: ${target.reasoning}`)
    })
  }
}

async function writeReport (pkgIdentifier, targets, outputPath, meta = {}) {
  // Handle scoped packages properly (e.g., @nestjs/core)
  const pkgName = pkgIdentifier.startsWith('@') ? pkgIdentifier : pkgIdentifier.split('@')[0]
  const report = {
    library_name: pkgName,
    language: 'nodejs',
    category: meta.category || 'other',
    subcategory: meta.subcategory || null,
    capabilities: meta.capabilities || {},
    similar_integration: meta.similar_integration || null,
    docs_signals: meta.docs_signals || {},
    test_examples: meta.test_examples || null,
    cautions: meta.cautions || [],
    assistant_notes: meta.assistant_notes || '',
    version_analysis: meta.version_analysis || null,
    targets: targets.map(target => ({
      // TODO: Add confidence scores and reasoning
      ...target
    }))
  }

  const reportJson = JSON.stringify(report, null, 2)
  await fs.writeFile(path.resolve(outputPath), reportJson)
}

function canonicalizeAndFilterTargets (pkgRoot, targets, opts) {
  const extMapPath = require('path').join(pkgRoot, '.ddapm-ext-cache', 'external-map.json')
  let extMap = {}
  try { extMap = JSON.parse(require('fs').readFileSync(extMapPath, 'utf8')) } catch {}

  const normalized = targets.map(t => {
    if (t.file_path && t.file_path.startsWith('.ddapm-ext-cache/')) {
      const match = t.file_path.match(/\.ddapm-ext-cache\/(.*?)\//)
      const key = match && match[1]
      const module = key && extMap[key]
      const rel = key ? t.file_path.replace(`.ddapm-ext-cache/${key}/`, '') : t.file_path
      return { ...t, module: module || null, file_path: rel }
    }
    return t
  })

  // Prune internal/private variants when a public counterpart exists in the same group
  let pruned = pruneNestedFunctions(normalized)

  // Category-aware score boosts and coverage
  const category = opts.category || 'other'
  pruned = boostCategoryScores(pruned, category, opts.docSignals)
  pruned = ensureCategoryCoverage(pruned, category)

  // Apply score threshold
  const filtered = pruned.filter(t => (t.confidence_score || 0) >= (opts.minScore || 0))

  // Group by export_name and cap per group
  const byExport = new Map()
  for (const t of filtered) {
    const k = t.export_name || 'default'
    if (!byExport.has(k)) byExport.set(k, [])
    byExport.get(k).push(t)
  }
  const capped = []
  for (const arr of byExport.values()) {
    arr.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
    capped.push(...arr.slice(0, opts.maxPerExport || Infinity))
  }

  capped.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
  return capped.slice(0, opts.maxTotal || Infinity)
}

function pruneNestedFunctions (targets) {
  const groups = new Map()
  for (const t of targets) {
    const key = `${t.module || ''}|${t.file_path || ''}|${t.export_name || 'default'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const out = []
  for (const arr of groups.values()) {
    const byRoot = new Map()
    for (const t of arr) {
      const root = normalizeRoot(t.function_name || '')
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root).push(t)
    }
    for (const variants of byRoot.values()) {
      // Pick best variant by penalty, then by higher confidence
      let best = null
      let bestPenalty = Infinity
      for (const v of variants) {
        const name = String(v.function_name || '')
        const penalty = computePenalty(name)
        if (penalty < bestPenalty) {
          best = v
          bestPenalty = penalty
        } else if (penalty === bestPenalty) {
          const a = v.confidence_score || 0
          const b = (best.confidence_score || 0)
          if (a > b) best = v
        }
      }
      if (best) out.push(best)
    }
  }
  return out
}

function normalizeRoot (name) {
  const base = String(name).replace(/^_+/, '')
  return base.replace(/(Internal|Impl|Helper|Core)$/i, '')
}

function computePenalty (name) {
  let p = 0
  if (/^_+/.test(name)) p += 2
  if (/(Internal|Impl|Helper|Core)$/i.test(name)) p += 1
  const root = normalizeRoot(name)
  p += Math.max(0, name.length - root.length)
  return p
}

function getCategoryVerbs (category) {
  switch (category) {
    case 'db':
      return { verbs: ['query', 'execute', 'send', 'sendcommand', 'sendCommand'] }
    case 'web':
      return { verbs: ['request', 'listen', 'handle'] }
    case 'http':
      return { verbs: ['request', 'fetch', 'get', 'post'] }
    case 'messaging':
      return {
        producer: ['produce', 'publish', 'send', 'enqueue', 'add'],
        consumer: ['consume', 'subscribe', 'on', 'process', 'run', 'receive']
      }
    case 'cache':
      return { verbs: ['command', 'get', 'set', 'del'] }
    default:
      return { verbs: ['request', 'execute', 'send'] }
  }
}

function boostCategoryScores (targets, category, docSignals) {
  const boosted = []
  const verbs = getCategoryVerbs(category)
  const docVerbSet = new Set()
  if (docSignals) {
    for (const v of (docSignals.matched_verbs || [])) docVerbSet.add(v)
  }
  for (const t of targets) {
    const name = String(t.function_name || '').toLowerCase()
    let bonus = 0
    if (category === 'messaging') {
      if (verbs.producer?.some(v => name === v)) bonus += 0.2
      if (verbs.consumer?.some(v => name === v)) bonus += 0.2
    } else if (verbs.verbs?.some(v => name === v)) {
      bonus += 0.2
    }
    if (docVerbSet.has(name)) bonus += 0.15
    if (bonus) {
      boosted.push({ ...t, confidence_score: Math.min(1, (t.confidence_score || 0) + bonus) })
    } else {
      boosted.push(t)
    }
  }
  return boosted
}

function ensureCategoryCoverage (targets, category) {
  if (category !== 'messaging') return targets
  const verbs = getCategoryVerbs(category)
  let bestProducer = null
  let bestConsumer = null
  for (const t of targets) {
    const name = String(t.function_name || '').toLowerCase()
    if (verbs.producer?.some(v => name === v)) {
      if (!bestProducer || (t.confidence_score || 0) > (bestProducer.confidence_score || 0)) {
        bestProducer = t
      }
    }
    if (verbs.consumer?.some(v => name === v)) {
      if (!bestConsumer || (t.confidence_score || 0) > (bestConsumer.confidence_score || 0)) {
        bestConsumer = t
      }
    }
  }
  const out = targets.slice()
  const addIfMissing = (pick) => {
    if (!pick) return
    const key = `${pick.module || ''}|${pick.export_name}|${pick.function_name}|${pick.file_path}`
    const seen = new Set(out.map(x => `${x.module || ''}|${x.export_name}|${x.function_name}|${x.file_path}`))
    if (!seen.has(key)) out.unshift({ ...pick, confidence_score: Math.max(0.99, pick.confidence_score || 0.99) })
  }
  addIfMissing(bestProducer)
  addIfMissing(bestConsumer)
  return out
}

// Heuristics duplicated here to keep analyzer self-contained
function detectCategory (npmName, targets, docSignals) {
  const name = String(npmName || '').toLowerCase()
  const keywords = (docSignals && docSignals.sources && Array.isArray(docSignals.sources.package_keywords))
    ? docSignals.sources.package_keywords.map(s => String(s).toLowerCase())
    : []
  const fnNames = new Set((targets || []).map(t => String(t.function_name || '').toLowerCase()))

  const countMatches = (items, corpus) => items.reduce((acc, it) => acc + (corpus.has ? (corpus.has(it) ? 1 : 0) : (corpus.includes(it) ? 1 : 0)), 0)

  const buckets = {
    messaging: {
      verbTokens: [
        'publish', 'subscribe', 'consume', 'send', 'receive', 'enqueue', 'add', 'pull',
        // queue/mq specific
        'sendMessage', 'sendImmediately', 'createSender', 'producer', 'consumer'
      ],
      keywordTokens: [
        'messaging', 'message', 'pubsub', 'queue', 'mq', 'topic', 'stream', 'broker',
        // queue ecosystems
        'kafka', 'kafkajs', 'amqp', 'amqplib', 'amqp10', 'rabbit', 'rhea', 'sqs', 'sns', 'nats',
        'bull', 'bullmq', 'pubsub'
      ]
    },
    db: {
      verbTokens: [
        'query', 'execute', 'command', 'insert', 'update', 'delete', 'find', 'aggregate', 'cursor',
        // mined
        'process', 'batch', '_execute', '_innerExecute', '_sendOnConnection', 'start', 'send', 'request',
        'getConnection', 'select', 'remove', '_getmore', '_find', 'kill', 'maybePromise', 'getMore',
        'killCursors', 'then', 'addQueue', 'exec', 'createPool', 'makeRequest'
      ],
      keywordTokens: [
        'database', 'db', 'sql', 'table', 'schema', 'collection', 'orm',
        // mined
        'aerospike', 'cassandra-driver', 'elasticsearch', 'mongodb-core', 'mongoose', 'mysql',
        'oracledb', 'pg', 'tedious'
      ]
    },
    web: {
      verbTokens: [
        'listen', 'handle', 'use', 'route', 'middleware', 'render', 'register', 'handleRequest',
        // mined
        'fromNodeNextRequest', 'serveStatic', 'renderToResponse', 'renderErrorToResponse',
        'findPageComponents', 'handleApiRequest', 'renderToHTML', 'renderErrorToHTML', 'formData',
        '_handleMessage'
      ],
      keywordTokens: [
        'web', 'framework', 'router', 'server', 'middleware',
        // frameworks and subtypes
        'express', 'fastify', 'graphql', 'gql', 'mercurius', 'apollo', 'grpc', 'http', 'http2', 'moleculer',
        'nestjs', 'nest',
        // mined
        'next', 'sharedb'
      ]
    },
    http: {
      verbTokens: ['request', 'fetch', 'get', 'post', 'put', 'delete'],
      keywordTokens: ['http', 'client', 'rest']
    },
    cache: {
      verbTokens: [
        'get', 'set', 'del', 'expire', 'ttl',
        // mined
        'command', 'addCommand', 'create', 'internal_send_command', 'send_command'
      ],
      keywordTokens: ['cache', 'caching', 'lru', 'memo', 'memcached', 'redis']
    }
  }

  const nameHints = {
    messaging: /(kafka|amqp|rabbit|sqs|sns|nats|bull|bullmq|queue|pubsub|mq|topic|stream|message)/,
    db: /(db|sql|orm|collection|database)/,
    web: /(express|fastify|graphql|gql|mercurius|apollo|grpc|router|server|framework|middleware|moleculer|nestjs|nest)/,
    http: /(http|rest|fetch|request)/,
    cache: /(cache|lru|memo)/
  }

  const scores = { messaging: 0, db: 0, web: 0, http: 0, cache: 0 }
  const weights = {
    messaging: { code: 1.0, doc: 0.8, kw: 1.2, name: 0.8 },
    db: { code: 1.5, doc: 1.0, kw: 1.0, name: 0.5 },
    web: { code: 0.8, doc: 1.5, kw: 2.0, name: 1.0 },
    http: { code: 1.0, doc: 1.0, kw: 1.5, name: 1.0 },
    cache: { code: 1.0, doc: 0.8, kw: 1.2, name: 0.8 }
  }
  for (const [cat, { verbTokens, keywordTokens }] of Object.entries(buckets)) {
    const codeScore = countMatches(verbTokens, fnNames)
    const docVerbScore = countMatches(verbTokens, docSignals?.matched_verbs || [])
    const kwScore = keywordTokens.reduce((acc, kw) => acc + (keywords.some(k => k.includes(kw)) ? 1 : 0), 0)
    const nameScore = nameHints[cat].test(name) ? 1 : 0
    const w = weights[cat]
    scores[cat] = codeScore * w.code + docVerbScore * w.doc + kwScore * w.kw + nameScore * w.name
  }

  // Guardrails: if strong web keywords present and no messaging keywords, bias to web
  const hasWebKW = buckets.web.keywordTokens.some(kw => keywords.some(k => k.includes(kw))) || nameHints.web.test(name)
  const hasMsgKW = buckets.messaging.keywordTokens.some(kw => keywords.some(k => k.includes(kw))) || nameHints.messaging.test(name)
  if (hasWebKW && !hasMsgKW) {
    scores.web += 3
    scores.messaging *= 0.5
  }

  let bestCat = 'other'
  let bestScore = 0
  for (const [cat, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      bestScore = sc
      bestCat = cat
    }
  }
  return bestScore >= 2 ? bestCat : 'other'
}

function inferCapabilities (targets, category) {
  // Producer/consumer capabilities are only relevant for messaging libraries
  if (category !== 'messaging') {
    return { producer: false, consumer: false }
  }

  const names = new Set((targets || []).map(t => String(t.function_name || '').toLowerCase()))
  const text = Array.from(names).join(' ')
  const hasProducer = /produce|publish|send|add\b|enqueue|push/.test(text)
  const hasConsumer = /consume|subscribe|on\b|run\b|process\b|worker/.test(text)
  return { producer: !!hasProducer, consumer: !!hasConsumer }
}

function suggestSimilarIntegration (category) {
  switch (category) {
    case 'db': return 'mysql' // representative db integration
    case 'web': return 'fastify' // representative web framework
    case 'http': return 'undici' // representative http client
    case 'messaging': return 'confluentinc-kafka-javascript' // representative messaging
    case 'cache': return 'redis' // representative cache client
    default: return null
  }
}

function extractDocSignals (pkgRoot, pkgName, npmMetadata) {
  // Scan README.md, docs/**/*.md, package.json keywords + NPM registry data
  const fsRaw = require('fs')
  const pathMod = require('path')
  const readIf = (p) => {
    try { return fsRaw.readFileSync(p, 'utf8') } catch { return '' }
  }
  const readme = readIf(pathMod.join(pkgRoot, 'README.md'))
  const changelog = readIf(pathMod.join(pkgRoot, 'CHANGELOG.md'))

  // Use NPM registry README if it's more comprehensive
  const npmReadme = npmMetadata?.readme || ''
  const bestReadme = npmReadme.length > readme.length ? npmReadme : readme
  // naive docs folder scan (non-recursive for speed)
  let docsText = ''
  try {
    const docsDir = pathMod.join(pkgRoot, 'docs')
    for (const f of fsRaw.readdirSync(docsDir)) {
      if (/\.(md|mdx)$/i.test(f)) docsText += '\n' + readIf(pathMod.join(docsDir, f))
    }
  } catch {}
  let keywords = []
  try {
    const pkgJson = JSON.parse(fsRaw.readFileSync(pathMod.join(pkgRoot, 'package.json'), 'utf8'))
    if (Array.isArray(pkgJson.keywords)) keywords = pkgJson.keywords.map(String)
  } catch {}

  // Enhance keywords with NPM registry data
  if (npmMetadata?.keywords) {
    keywords = [...keywords, ...npmMetadata.keywords].filter(Boolean)
  }

  // Use enhanced description if available
  const description = npmMetadata?.description || ''

  const all = [bestReadme, docsText, changelog, description, keywords.join(' ')].join('\n')
  const matched = new Set()
  const tokenSets = [
    ['publish', 'subscribe', 'consume', 'send', 'receive', 'enqueue', 'add', 'pull'],
    ['query', 'execute', 'command', 'insert', 'update', 'delete', 'find', 'aggregate'],
    ['listen', 'handle', 'route', 'middleware', 'render'],
    ['request', 'fetch', 'get', 'post', 'put'],
    ['get', 'set', 'del', 'expire', 'ttl']
  ]
  for (const arr of tokenSets) {
    for (const v of arr) {
      const re = new RegExp(`\\b${v}\\b`, 'i')
      if (re.test(all)) matched.add(v)
    }
  }

  return {
    sources: {
      readme: !!readme,
      docs: !!docsText,
      changelog: !!changelog,
      package_keywords: keywords
    },
    matched_verbs: Array.from(matched)
  }
}

// Extract basic usage examples from docs to drive test setup and actions
function extractDocExamples (pkgRoot, pkgName, category, targets, docSignals, enhancedDocs, subcategory = null) {
  const fsRaw = require('fs')
  const pathMod = require('path')
  const readIf = (p) => {
    try { return fsRaw.readFileSync(p, 'utf8') } catch { return '' }
  }
  const readme = readIf(pathMod.join(pkgRoot, 'README.md'))

  // Use the best available documentation source
  const text = enhancedDocs?.repository || enhancedDocs?.readme || enhancedDocs?.homepage || readme

  // Debug: log documentation source and category
  if (process.env.DD_DEBUG_DOCS) {
    console.log(`\n[DEBUG] Package: ${pkgName}, Category: ${category}`)
    console.log(`[DEBUG] Text sources: repository=${!!enhancedDocs?.repository}, readme=${!!enhancedDocs?.readme}, homepage=${!!enhancedDocs?.homepage}, local=${!!readme}`)
    console.log(`[DEBUG] Using: ${enhancedDocs?.repository ? 'repository' : enhancedDocs?.readme ? 'npm-readme' : enhancedDocs?.homepage ? 'homepage' : 'local-readme'}`)
    console.log(`[DEBUG] Text length: ${text.length}`)
  }

  // Category-aware defaults if docs don't provide clearer snippets
  if (category === 'messaging') {
    const importLine = 'const mod = require(`../../../versions/' + pkgName + '@${' + 'version' + '}`).get()'
    const lowerFnNames = new Set((targets || []).map(t => String(t.function_name || '').toLowerCase()))
    const hasPublish = lowerFnNames.has('publish') || /\bpublish\b/i.test(text)
    const hasSubscribe = lowerFnNames.has('subscribe') || /\bsubscribe\b/i.test(text)
    const hasConnect = lowerFnNames.has('connect') || /\bconnect\b/i.test(text)

    // Generate NATS-style or generic pub/sub based on verbs present
    const setup = [
      importLine,
      hasConnect ? 'const { connect, StringCodec } = mod' : 'const { StringCodec } = mod',
      hasConnect ? 'const nc = await connect({ servers: process.env.NATS_URL || "nats://127.0.0.1:4222" })' : '// const nc = await connect(...)',
      'const sc = StringCodec()'
    ]

    const actions = ['if (!process.env.DD_EXAMPLE_RUN) return']
    if (hasSubscribe) {
      actions.push(
        "const sub = nc.subscribe('dd.trace.test')",
        'const subIter = (async () => { for await (const m of sub) { break } })()'
      )
    }
    if (hasPublish) {
      actions.push(
        "await nc.publish('dd.trace.test', sc.encode('hello'))"
      )
    }
    actions.push(
      'await (subIter && subIter.catch(() => {}))',
      'await nc.flush()',
      'await nc.drain()'
    )
    return { setup_lines: setup, action_lines: actions }
  }

  if (category === 'db') {
    const importLine = 'const mod = require(`../../../versions/' + pkgName + '@${' + 'version' + '}`).get()'
    return {
      setup_lines: [
        importLine,
        '// const client = new mod.Client(/* connection */)',
        '// await client.connect()'
      ],
      action_lines: [
        "// await client.query('SELECT 1')"
      ]
    }
  }

  if (category === 'web') {
    const importLine = 'const mod = require(`../../../versions/' + pkgName + '@${' + 'version' + '}`).get()'
    const lowerFnNames = new Set((targets || []).map(t => String(t.function_name || '').toLowerCase()))

    // Analyze the library's specific patterns from documentation and targets
    const looksNestJS = /nestjs|nest/i.test(text) || pkgName.includes('nestjs')
    const looksFastify = /fastify|mercurius|graphql/i.test(text) || pkgName.includes('fastify')
    const looksExpress = /express/i.test(text) || pkgName.includes('express') || lowerFnNames.has('use')
    const looksHapi = /hapi/i.test(text) || pkgName.includes('hapi')
    const looksKoa = /koa/i.test(text) || pkgName.includes('koa')

    // Extract common setup patterns from README and targets
    const hasListen = lowerFnNames.has('listen') || /\.listen\(/i.test(text)
    const hasUse = lowerFnNames.has('use') || /\.use\(/i.test(text)
    const hasGet = lowerFnNames.has('get') || /\.get\(/i.test(text)
    const hasRegister = lowerFnNames.has('register') || /\.register\(/i.test(text)

    // Generate library-specific setup based on detected patterns
    if (looksNestJS) {
      return {
        setup_lines: [
          importLine,
          'const { NestFactory } = mod',
          'const { Module, Controller, Get } = require(\'@nestjs/common\')',
          '@Controller() class AppController { @Get() getHello() { return "Hello" } }',
          '@Module({ controllers: [AppController] }) class AppModule {}',
          'const app = await NestFactory.create(AppModule)',
          'await app.listen(0)',
          'const port = app.getHttpServer().address().port'
        ],
        action_lines: [
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'const axios = require(\'axios\')',
          'const res = await axios.get(`http://localhost:${port}/`)',
          'await app.close()'
        ]
      }
    } else if (looksFastify) {
      const isGraphQL = /graphql|mercurius/i.test(text)
      if (isGraphQL) {
        return {
          setup_lines: [
            importLine,
            "const fastify = require('fastify')()",
            "await fastify.register(mod, { schema: { typeDefs: 'type Query { hello: String }', resolvers: { Query: { hello: () => 'world' } } } })",
            'await fastify.listen({ port: 0 })',
            'const port = fastify.server.address().port'
          ],
          action_lines: [
            'if (!process.env.DD_EXAMPLE_RUN) return',
            "const res = await fastify.inject({ method: 'POST', url: '/graphql', payload: { query: '{ hello }' } })",
            'await fastify.close()'
          ]
        }
      } else {
        return {
          setup_lines: [
            importLine,
            'const fastify = require(\'fastify\')()',
            hasRegister ? 'await fastify.register(mod)' : '// await fastify.register(mod)',
            hasGet ? "fastify.get('/', async () => 'Hello World')" : "// fastify.get('/', ...)",
            'await fastify.listen({ port: 0 })',
            'const port = fastify.server.address().port'
          ],
          action_lines: [
            'if (!process.env.DD_EXAMPLE_RUN) return',
            'const axios = require(\'axios\')',
            'const res = await axios.get(`http://localhost:${port}/`)',
            'await fastify.close()'
          ]
        }
      }
    } else if (looksExpress || looksHapi || looksKoa) {
      const framework = looksHapi ? 'hapi' : looksKoa ? 'koa' : 'express'
      return {
        setup_lines: [
          importLine,
          framework === 'express' ? 'const app = mod()' : framework === 'koa' ? 'const app = new mod()' : 'const server = mod.server({ port: 0 })',
          framework === 'express' ? "app.get('/', (req, res) => res.send('Hello'))" : framework === 'koa' ? "app.use(ctx => { ctx.body = 'Hello' })" : "server.route({ method: 'GET', path: '/', handler: () => 'Hello' })",
          framework === 'hapi' ? 'await server.start()' : 'const server = app.listen(0)',
          framework === 'hapi' ? 'const port = server.info.port' : 'const port = server.address().port'
        ],
        action_lines: [
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'const axios = require(\'axios\')',
          'const res = await axios.get(`http://localhost:${port}/`)',
          framework === 'hapi' ? 'await server.stop()' : 'server.close()'
        ]
      }
    } else {
      // Generic web framework
      return {
        setup_lines: [
          importLine,
          'const app = mod()',
          hasGet ? "app.get('/', (req, res) => res.send('Hello'))" : "// app.get('/', ...)",
          hasListen ? 'const server = app.listen(0)' : '// const server = app.listen(0)',
          'const port = server.address().port'
        ],
        action_lines: [
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'const axios = require(\'axios\')',
          'const res = await axios.get(`http://localhost:${port}/`)',
          'server.close()'
        ]
      }
    }
  }

  if (category === 'http') {
    const importLine = 'const mod = require(`../../../versions/' + pkgName + '@${' + 'version' + '}`).get()'

    if (subcategory === 'client') {
      // HTTP clients like axios - need a test server in setup, client requests in actions
      return {
        setup_lines: [
          importLine,
          'const http = require(\'http\')',
          'const PORT = 3000',
          'let server',
          'server = http.createServer((req, res) => {',
          '  if (req.url === \'/success\') {',
          '    res.writeHead(200, { \'Content-Type\': \'application/json\' })',
          '    res.end(JSON.stringify({ message: \'success\' }))',
          '  } else if (req.url === \'/error\') {',
          '    res.writeHead(500, { \'Content-Type\': \'application/json\' })',
          '    res.end(JSON.stringify({ error: \'server error\' }))',
          '  } else {',
          '    res.writeHead(404)',
          '    res.end()',
          '  }',
          '})',
          'await new Promise(resolve => server.listen(PORT, resolve))'
        ],
        action_lines: [
          'const response = await mod.get(`http://localhost:${PORT}/success`)',
          'expect(response.status).to.equal(200)',
          'const errorResponse = await mod.get(`http://localhost:${PORT}/error`).catch(err => err.response)',
          'expect(errorResponse.status).to.equal(500)'
        ]
      }
    } else if (subcategory === 'server') {
      // HTTP servers like express - setup app/middleware, test with requests
      return {
        setup_lines: [
          importLine,
          'const request = require(\'supertest\')'
        ],
        action_lines: [
          'const app = mod()',
          'app.get(\'/test\', (req, res) => res.json({ ok: true }))',
          'app.get(\'/error\', (req, res) => res.status(500).json({ error: \'test error\' }))',
          'const response = await request(app).get(\'/test\')',
          'expect(response.status).to.equal(200)',
          'expect(response.body).to.deep.equal({ ok: true })',
          'const errorResponse = await request(app).get(\'/error\')',
          'expect(errorResponse.status).to.equal(500)'
        ]
      }
    } else {
      // Fallback to client pattern for unknown subcategory
      return {
        setup_lines: [
          importLine,
          'const http = require(\'http\')',
          'const PORT = 3000',
          'let server',
          'server = http.createServer((req, res) => {',
          '  if (req.url === \'/test\') {',
          '    res.writeHead(200, { \'Content-Type\': \'application/json\' })',
          '    res.end(JSON.stringify({ message: \'Hello from server!\' }))',
          '  } else {',
          '    res.writeHead(404)',
          '    res.end()',
          '  }',
          '})',
          'await new Promise(resolve => server.listen(PORT, resolve))'
        ],
        action_lines: [
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'try {',
          '  const response = await mod.get(`http://localhost:${PORT}/test`)',
          '  console.log(\'Response:\', response.data || response)',
          '} catch (error) {',
          '  console.error(\'Request failed:\', error.message)',
          '} finally {',
          '  if (server) {',
          '    await new Promise(resolve => server.close(resolve))',
          '  }',
          '}'
        ]
      }
    }
  }

  return null
}

// Best-effort bundling detector to warn users about patchability
function detectBundledArtifacts (pkgRoot) {
  const fsRaw = require('fs')
  const pathMod = require('path')
  const cautions = []
  try {
    const pkgJson = JSON.parse(fsRaw.readFileSync(pathMod.join(pkgRoot, 'package.json'), 'utf8'))
    const candidates = []
    if (pkgJson.main) candidates.push(pkgJson.main)
    if (pkgJson.module) candidates.push(pkgJson.module)
    if (pkgJson.exports && typeof pkgJson.exports === 'object') {
      for (const v of Object.values(pkgJson.exports)) {
        if (typeof v === 'string') candidates.push(v)
        else if (v && typeof v === 'object') {
          if (typeof v.require === 'string') candidates.push(v.require)
          if (typeof v.import === 'string') candidates.push(v.import)
          if (typeof v.default === 'string') candidates.push(v.default)
        }
      }
    }
    const seen = new Set()
    for (const rel of candidates) {
      const p = pathMod.join(pkgRoot, rel)
      if (seen.has(p)) continue
      seen.add(p)
      let src = ''
      try { src = fsRaw.readFileSync(p, 'utf8') } catch { continue }
      const signals = [
        /var\s+__defProp\s*=\s*Object\.defineProperty/,
        /var\s+__export\s*=\s*\(target,\s*all\)/,
        /var\s+__toCommonJS\s*=\s*\(/,
        /Object\.defineProperty\(exports,\s*['"][^'"]+['"],\s*\{\s*get:\s*function/,
        /__exportStar\(/
      ]
      if (signals.some(re => re.test(src))) {
        cautions.push('This package appears to be bundled (re-export helpers detected). Monkey-patching internals may be unreliable; prefer instrumenting underlying drivers or stable public methods.')
        break
      }
    }
  } catch {}
  return cautions
}

async function detectCategoryWithLLM (pkgName, targets, docSignals, enhancedDocs) {
  console.log(`\nDetecting category for ${pkgName} using LLM...`)

  // Build context for LLM
  const topTargets = (targets || [])
    .slice(0, 10)
    .map(t => `${t.export_name}.${t.function_name} (score: ${t.confidence_score})`)
    .join('\n')

  const keywords = (docSignals?.sources?.package_keywords || []).join(', ')
  const description = docSignals?.sources?.package_description || ''
  const docPreview = enhancedDocs?.readme?.substring(0, 1500) ||
    enhancedDocs?.homepage?.substring(0, 1500) ||
    docSignals?.sources?.readme_text?.substring(0, 1500) || ''

  const system = `You are an expert Node.js library categorization specialist. Your task is to categorize npm packages for APM instrumentation purposes.

VALID CATEGORIES:
- "messaging": Message queues, pub/sub, brokers (Kafka, RabbitMQ, Redis pub/sub, Bull queues, etc.)
- "db": Databases, ORMs, query builders (MongoDB, MySQL, PostgreSQL, Prisma, Sequelize, etc.)
- "web": Web frameworks, HTTP servers (Express, Fastify, NestJS, Koa, Hapi, etc.)
- "http": HTTP clients, REST clients (axios, node-fetch, got, etc.)
- "cache": Caching libraries (Redis for caching, Memcached, node-cache, etc.)
- "other": Everything else (utilities, loggers, parsers, etc.)

IMPORTANT RULES:
1. Focus on the PRIMARY use case of the library
2. Redis can be "cache" (for caching) or "messaging" (for pub/sub) - analyze the functions
3. GraphQL servers are "web", GraphQL clients are "http"
4. Be conservative - when unsure, use "other"

Respond with ONLY a JSON object:
{
  "category": "category_name",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this category was chosen"
}`

  const user = `Package: ${pkgName}

Functions found:
${topTargets || 'No functions found'}

Keywords: ${keywords}
Description: ${description}

Documentation preview:
${docPreview}

What category best describes this library?`

  try {
    const response = await askLLM(system, user)
    if (!response) return null

    const parsed = extractJSONFromResponse(response)
    if (parsed && parsed.category && parsed.confidence && parsed.reasoning) {
      console.log(`LLM categorized as: ${parsed.category} (confidence: ${parsed.confidence})`)
      console.log(`Reasoning: ${parsed.reasoning}`)
      return parsed
    } else {
      console.warn('LLM response missing required fields:', { parsed })
    }
  } catch (error) {
    console.warn('Failed to parse LLM category response:', error.message)
  }

  return null
}

async function promptUserForCategory (pkgName, llmResult, heuristicResult) {
  const readline = require('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  console.log(`\n🤔 Category detection results for ${pkgName}:`)
  if (llmResult) {
    console.log(`  LLM suggests: '${llmResult.category}' (confidence: ${llmResult.confidence})`)
    console.log(`  Reasoning: ${llmResult.reasoning}`)
  }
  console.log(`  Heuristic suggests: '${heuristicResult}'`)

  console.log('\nValid categories: messaging, db, web, http, cache, other')

  return new Promise((resolve) => {
    const question = 'Enter the correct category (or press Enter to accept LLM suggestion): '
    rl.question(question, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      const validCategories = ['messaging', 'db', 'web', 'http', 'cache', 'other']
      if (trimmed && validCategories.includes(trimmed)) {
        resolve(trimmed)
      } else if (llmResult && llmResult.category) {
        resolve(llmResult.category)
      } else {
        resolve(heuristicResult)
      }
    })
  })
}

function extractJSONFromResponse (response) {
  if (!response || typeof response !== 'string') {
    return null
  }

  // Try parsing as-is first
  try {
    return JSON.parse(response.trim())
  } catch (e) {
    // Continue to extraction methods
  }

  // Extract JSON from markdown code blocks
  const jsonBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim())
    } catch (e) {
      // Continue to other methods
    }
  }

  // Extract JSON from curly braces (find the largest valid JSON object)
  const braceMatches = response.match(/\{[\s\S]*\}/)
  if (braceMatches) {
    for (const match of braceMatches) {
      try {
        return JSON.parse(match)
      } catch (e) {
        // Try next match
        continue
      }
    }
  }

  // Last resort: try to find JSON-like content between first { and last }
  const firstBrace = response.indexOf('{')
  const lastBrace = response.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    try {
      return JSON.parse(response.substring(firstBrace, lastBrace + 1))
    } catch (e) {
      // Give up
    }
  }

  return null
}

async function callLLMViaPython (messages, model, maxTokens = 600, temperature = 0.2) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'llm_bridge.py')
    const python = spawn('python3', [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const input = JSON.stringify({
      messages,
      model,
      max_tokens: maxTokens,
      temperature
    })
    let output = ''
    let error = ''

    python.stdout.on('data', (data) => {
      output += data.toString()
    })

    python.stderr.on('data', (data) => {
      error += data.toString()
    })

    python.on('close', (code) => {
      if (code !== 0) {
        console.warn('Python LLM bridge failed:', error)
        resolve(null)
        return
      }

      try {
        const result = JSON.parse(output)
        if (result.success) {
          resolve(result.content)
        } else {
          console.warn('LLM call failed:', result.error)
          resolve(null)
        }
      } catch (parseError) {
        console.warn('Failed to parse LLM response:', parseError.message)
        resolve(null)
      }
    })

    python.stdin.write(input)
    python.stdin.end()
  })
}

async function enhanceAnalysisWithLLM (pkgName, category, targets, docExamples, similarIntegration, enhancedDocs, extractedPath) {
  console.log(`\nEnhancing analysis with LLM for ${pkgName}...`)

  // Always enhance test examples for better quality
  const needsExamples = true // Always try to improve test examples

  const needsSimilarIntegration = !similarIntegration || similarIntegration === 'unknown'

  console.log('Running LLM enhancement to improve test examples and verify similar integration...')

  // Build context for LLM
  const topTargets = (targets || [])
    .slice(0, 8)
    .map(t => `${t.export_name}.${t.function_name} (score: ${t.confidence_score})`)
    .join('\n')

  const docContext = enhancedDocs?.repository || enhancedDocs?.readme || enhancedDocs?.homepage || 'No documentation available'
  const docPreview = docContext.substring(0, 2000) + (docContext.length > 2000 ? '...' : '')

  const system = `You are an expert Node.js APM instrumentation engineer. Your task is to enhance analysis results for the package "${pkgName}" (category: ${category}).

Available information:
- Top instrumentation targets:
${topTargets}

- Documentation preview:
${docPreview}`

  let user = ''
  const result = { docExamples, similarIntegration }

  // Enhance test examples if needed
  if (needsExamples) {
    console.log('Generating enhanced test examples...')

    const existingExamples = docExamples && docExamples.setup_lines && docExamples.action_lines
      ? `\n\nExisting examples to improve upon:
Setup: ${JSON.stringify(docExamples.setup_lines, null, 2)}
Actions: ${JSON.stringify(docExamples.action_lines, null, 2)}`
      : '\n\nNo existing examples - create from scratch.'

    user = `Generate realistic, working test setup and action code for ${pkgName}. This should be actual executable code that demonstrates how to use the library properly.${existingExamples}

Requirements:
1. setup_lines: Array of lines to set up the library (imports, initialization, server/client creation, etc.)
2. action_lines: Array of lines that exercise the library (make requests, call methods, test functionality, cleanup)
3. Use template strings for versions: \`../../../versions/${pkgName}@\${version}\`
4. Include proper variable hoisting (declare variables at the top)
5. Make it realistic and executable - this will be used in actual tests
6. Include cleanup/teardown if needed (close connections, servers, etc.)
7. For ${category} libraries, follow common patterns and best practices
8. Ensure all variables are properly declared and scoped
9. For HTTP clients: Put server setup in setup_lines, HTTP requests in action_lines
10. For web servers: Put server creation in setup_lines, request handling tests in action_lines

Return ONLY a JSON object with this structure:
{
  "setup_lines": ["line1", "line2", ...],
  "action_lines": ["line1", "line2", ...]
}`

    const examplesResponse = await askLLM(system, user)
    if (examplesResponse) {
      try {
        const parsedExamples = extractJSONFromResponse(examplesResponse)
        if (parsedExamples && parsedExamples.setup_lines && parsedExamples.action_lines) {
          // Verify the code works
          const verifiedExamples = await verifyAndFixCode(pkgName, category, parsedExamples, extractedPath)
          // Review setup/action separation with LLM
          const reviewedExamples = await reviewSetupActionSeparation(pkgName, category, verifiedExamples)
          // Clean up semicolons and fix variable hoisting
          result.docExamples = cleanupTestExamples(reviewedExamples)
          console.log('✅ Enhanced test examples generated and verified')
        } else {
          console.warn('LLM test examples response missing required fields:', { parsedExamples })
        }
      } catch (error) {
        console.warn('Failed to parse LLM examples response:', error.message)
      }
    }
  }

  // Enhance similar integration if needed
  if (needsSimilarIntegration) {
    console.log('Finding similar integration...')
    const similarUser = `Based on the package "${pkgName}" (category: ${category}), what existing dd-trace integration would be most similar for reference?

Consider these existing integrations by category:
- web: express, fastify, koa, hapi, moleculer
- db: mysql, pg, mongodb, redis, elasticsearch
- messaging: amqplib, kafkajs, bull, bullmq
- http: http, https, fetch, axios, undici
- cache: memcached, ioredis

Return ONLY the name of the most similar integration (e.g., "express" or "mysql").`

    const similarResponse = await askLLM(system, similarUser)
    if (similarResponse && similarResponse.trim()) {
      const similar = similarResponse.trim().replace(/['"]/g, '').toLowerCase()
      if (similar && similar !== 'unknown') {
        result.similarIntegration = similar
        console.log(`✅ Similar integration identified: ${similar}`)
      }
    }
  }

  return result
}

async function verifyAndFixCode (pkgName, category, examples, extractedPath, attempt = 1) {
  const maxAttempts = 3

  if (attempt > maxAttempts) {
    console.warn(`Max verification attempts reached for ${pkgName}`)
    return examples
  }

  console.log(`Verifying code (attempt ${attempt}/${maxAttempts})...`)

  // Basic syntax check
  const allLines = [...(examples.setup_lines || []), ...(examples.action_lines || [])]
  const codeToCheck = allLines.join('\n')

  // Check for common issues
  const issues = []

  // Check for unbalanced quotes/brackets
  const singleQuotes = (codeToCheck.match(/'/g) || []).length
  const doubleQuotes = (codeToCheck.match(/"/g) || []).length
  const openBrackets = (codeToCheck.match(/\(/g) || []).length
  const closeBrackets = (codeToCheck.match(/\)/g) || []).length
  const openBraces = (codeToCheck.match(/\{/g) || []).length
  const closeBraces = (codeToCheck.match(/\}/g) || []).length

  if (openBrackets !== closeBrackets) issues.push('Unbalanced parentheses')
  if (openBraces !== closeBraces) issues.push('Unbalanced braces')

  // Check for missing requires/imports
  if (!codeToCheck.includes('require(') && !codeToCheck.includes('import ')) {
    issues.push('Missing require/import statements')
  }

  // Check for incomplete lines
  if (allLines.some(line => line.trim().endsWith(',') && !line.includes('{'))) {
    issues.push('Incomplete statements ending with comma')
  }

  // Note: dd-trace uses no-semicolon style, so we don't check for missing semicolons

  // Check for template literal issues
  if (codeToCheck.includes('${version}') && !codeToCheck.includes('`')) {
    issues.push('Template literal syntax error - missing backticks')
  }

  // Note: await statements are valid in dd-trace test contexts (beforeEach, test functions)

  // If no issues found, return the examples
  if (issues.length === 0) {
    console.log('✅ Code verification passed')
    return examples
  }

  console.log(`Issues found: ${issues.join(', ')}. Attempting to fix...`)

  // Ask LLM to fix the issues
  const fixSystem = `You are a code fixing expert. Fix the following issues in the test code for ${pkgName}:`
  const fixUser = `Issues found: ${issues.join(', ')}

Current code:
${codeToCheck}

Please fix these issues and return a corrected JSON object with the same structure:
{
  "setup_lines": ["line1", "line2", ...],
  "action_lines": ["line1", "line2", ...]
}`

  const fixedResponse = await askLLM(fixSystem, fixUser)
  if (fixedResponse) {
    try {
      const fixedExamples = JSON.parse(fixedResponse)
      if (fixedExamples.setup_lines && fixedExamples.action_lines) {
        // Recursively verify the fixed code
        return await verifyAndFixCode(pkgName, category, fixedExamples, extractedPath, attempt + 1)
      }
    } catch (error) {
      console.warn('Failed to parse fixed code response:', error.message)
    }
  }

  // If fixing failed, return original examples
  console.warn('Code fixing failed, returning original examples')
  return examples
}

function cleanupTestExamples (examples) {
  if (!examples || !examples.setup_lines || !examples.action_lines) {
    return examples
  }

  // Remove semicolons and fix variable hoisting
  const cleanLine = (line) => {
    return line
      .replace(/;+$/, '') // Remove trailing semicolons
      .replace(/;\s*\/\//, ' //') // Remove semicolons before comments
  }

  const setupLines = examples.setup_lines.map(cleanLine)
  const actionLines = examples.action_lines.map(cleanLine)

  // Extract variable declarations from action lines and move to setup
  const variableDeclarations = []
  const cleanedActionLines = []

  for (const line of actionLines) {
    const trimmed = line.trim()
    // Check for variable declarations that should be hoisted
    if (trimmed.match(/^(let|const|var)\s+\w+/) && !trimmed.includes('=')) {
      variableDeclarations.push(trimmed)
    } else {
      cleanedActionLines.push(line)
    }
  }

  // Add hoisted variables to setup, but avoid duplicates
  const finalSetupLines = [...setupLines]
  for (const varDecl of variableDeclarations) {
    const varName = varDecl.match(/^(let|const|var)\s+(\w+)/)?.[2]
    if (varName && !setupLines.some(line => line.includes(varName))) {
      finalSetupLines.push(varDecl)
    }
  }

  return {
    setup_lines: finalSetupLines,
    action_lines: cleanedActionLines
  }
}

async function reviewSetupActionSeparation (pkgName, category, examples) {
  if (!examples || !examples.setup_lines || !examples.action_lines) {
    return examples
  }

  console.log('Reviewing setup/action separation...')

  const system = `You are an expert at organizing test code. Your job is to review test setup and action lines and ensure they are properly separated.

SETUP LINES should contain:
- Library imports and initialization
- Server/client creation and configuration
- Database connections and schema setup
- Variable declarations and configuration
- Infrastructure that needs to exist before testing

ACTION LINES should contain:
- Actual library method calls being tested
- HTTP requests, database queries, message publishing
- Assertions and validations
- Cleanup that happens after the test action

Review the current separation and move any action lines that should actually be in setup.`

  const user = `Package: ${pkgName}
Category: ${category}

Current setup_lines:
${JSON.stringify(examples.setup_lines, null, 2)}

Current action_lines:
${JSON.stringify(examples.action_lines, null, 2)}

Please review this separation and return a corrected version. Move any action lines that should actually be setup lines (like server listening, database connections, etc.) to setup_lines.

Return ONLY a JSON object with this structure:
{
  "setup_lines": ["line1", "line2", ...],
  "action_lines": ["line1", "line2", ...]
}`

  try {
    const response = await askLLM(system, user)
    if (response) {
      const reviewedExamples = extractJSONFromResponse(response)
      if (reviewedExamples && reviewedExamples.setup_lines && reviewedExamples.action_lines) {
        console.log('✅ Setup/action separation reviewed and optimized')
        return reviewedExamples
      } else {
        console.warn('LLM setup/action review response missing required fields')
      }
    }
  } catch (error) {
    console.warn('Failed to review setup/action separation:', error.message)
  }

  // Return original if review failed
  return examples
}

async function askLLM (system, user) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
  const model = process.env.DD_APM_LLM_MODEL || 'gpt-4o-mini'

  // Use company AI gateway via Python bridge if configured
  if (process.env.DD_AI_GATEWAY) {
    try {
      const result = await callLLMViaPython(messages, model, 600, 0.2)
      return result || ''
    } catch (error) {
      console.warn('Python LLM bridge failed:', error.message)
      return ''
    }
  }

  // Fallback to direct OpenAI for development
  if (!process.env.OPENAI_API_KEY || typeof fetch !== 'function') return ''
  try {
    const body = {
      model: model.replace('openai/', ''), // Remove provider prefix for direct OpenAI
      messages,
      temperature: 0.2,
      max_tokens: 600
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body)
    })
    if (!res.ok) return ''
    const data = await res.json()
    return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || ''
  } catch {
    return ''
  }
}
