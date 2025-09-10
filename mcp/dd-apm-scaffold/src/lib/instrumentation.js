'use strict'

const { normalizeForChannel, detectCategory, getOperationForCategory } = require('./utils')
const { lintGeneratedFile } = require('./linting')

/**
 * Generate data extraction code for instrumentation context
 */
function generateContextExtractionCode (target, integrationType) {
  if (!target.data_requirements || !target.data_requirements.breakdown) {
    return ['// TODO: Extract relevant data from arguments']
  }

  const { breakdown } = target.data_requirements
  const extractionLines = []

  // Process critical and important data requirements
  for (const [priority, dataTypes] of Object.entries(breakdown)) {
    if (priority === 'optional') continue // Skip optional for shimmer code

    for (const [dataType, info] of Object.entries(dataTypes)) {
      if (!info.available || !info.dataSources || info.dataSources.length === 0) continue

      const primarySource = info.dataSources[0]
      const extractionCode = generateShimmerExtractionCode(primarySource, dataType)

      if (extractionCode) {
        extractionLines.push(`      // Extract ${dataType} (${priority})`)
        extractionLines.push(`      ${extractionCode}`)
      }
    }
  }

  if (extractionLines.length === 0) {
    return ['// TODO: Extract relevant data from arguments']
  }

  return extractionLines
}

/**
 * Generate extraction code for shimmer wrapper functions
 */
function generateShimmerExtractionCode (source, dataType) {
  switch (source.type) {
    case 'argument':
      return `ctx.${dataType} = arguments[${source.position}]`

    case 'argument_property':
      return `ctx.${dataType} = arguments[${source.position}] && arguments[${source.position}].${source.property}`

    case 'function_name':
      if (dataType === 'method') {
        // Method will be passed as a parameter to the wrapper function
        return `ctx.${dataType} = methodName.toUpperCase() || 'GET'`
      }
      return `ctx.${dataType} = '${dataType}' // TODO: Extract from function context`

    case 'constructed_url':
      return `ctx.${dataType} = arguments[0] && (\`\${arguments[0].protocol || 'http'}://\${arguments[0].hostname}\${arguments[0].port ? ':' + arguments[0].port : ''}\${arguments[0].path || ''}\`)`

    case 'url_component':
      return `ctx.${dataType} = arguments[0] && (typeof arguments[0] === 'string' ? new URL(arguments[0]).${source.component} : null)`

    case 'module_name':
      if (source.examples && source.examples[0]) {
        const moduleValue = source.examples[0].split(' → ')[1] || dataType
        return `ctx.${dataType} = '${moduleValue}'`
      }
      return `ctx.${dataType} = '${dataType}' // TODO: Extract from module context`

    default:
      return `ctx.${dataType} = null // TODO: Extract from ${source.type}`
  }
}

function generateInstrumentationFile ({ npmName, integrationId, selected, category, versionAnalysis = null, report = null }) {
  const byModule = new Map()
  for (const t of selected) {
    const mod = t.module || npmName
    if (!byModule.has(mod)) byModule.set(mod, [])
    byModule.get(mod).push(t)
  }

  function toId (s) {
    const parts = String(s || '').split(/[^a-zA-Z0-9]+/).filter(Boolean)
    if (!parts.length) return 'fn'
    const head = parts[0].charAt(0).toLowerCase() + parts[0].slice(1)
    const tail = parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
    return head + tail
  }
  function toUpperId (s) {
    const id = toId(s)
    return id.charAt(0).toUpperCase() + id.slice(1)
  }
  function modVarName (moduleName) {
    return toId(normalizeForChannel(moduleName)) // e.g., socketIo
  }
  function isIdentifier (name) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name))
  }

  function generateVersionRanges (versionAnalysis, targets) {
    if (!versionAnalysis || !versionAnalysis.versionAnalyses) {
      return [{ range: '>=0', targets, comment: 'No version analysis available' }]
    }

    // Conservative approach: Generate broad ranges that ensure full coverage
    const analyzedVersions = Object.keys(versionAnalysis.versionAnalyses)
    const apiDifferences = versionAnalysis.apiDifferences || []

    // Identify major versions from analyzed versions
    const majorVersions = new Set()
    for (const version of analyzedVersions) {
      const major = version.split('.')[0]
      majorVersions.add(parseInt(major))
    }

    const sortedMajors = Array.from(majorVersions).sort((a, b) => a - b)
    const versionRanges = []

    // Generate conservative ranges that cover entire major versions
    for (let i = 0; i < sortedMajors.length; i++) {
      const currentMajor = sortedMajors[i]
      const nextMajor = sortedMajors[i + 1]

      let range
      let comment = ''

      if (nextMajor) {
        // Cover from current major to next major (exclusive)
        range = `>=${currentMajor}.0.0 <${nextMajor}.0.0`
        comment = `Major version ${currentMajor}.x coverage`
      } else {
        // Last major version - cover everything from this major onward
        range = `>=${currentMajor}.0.0`
        comment = `Major version ${currentMajor}.x+ coverage`
      }

      // Find targets that have breaking changes in this range
      const relevantTargets = targets.filter(target => {
        const targetKey = `${target.module}:${target.function_name}`

        // Check if this target has any API differences in this major version
        const hasChangesInRange = apiDifferences.some(diff => {
          if (diff.method !== targetKey) return false

          const diffMajor = parseInt(diff.toVersion.split('.')[0])
          return diffMajor === currentMajor
        })

        // Include target if it has changes in this range OR if it exists in analyzed versions
        return hasChangesInRange || analyzedVersions.some(version => {
          const versionMajor = parseInt(version.split('.')[0])
          const analysis = versionAnalysis.versionAnalyses[version]
          const hasTarget = analysis.targets?.some(t =>
            `${t.module}:${t.function_name}` === targetKey
          )
          return versionMajor === currentMajor && hasTarget
        })
      })

      if (relevantTargets.length > 0) {
        versionRanges.push({
          range,
          targets: relevantTargets,
          comment,
          majorVersion: currentMajor
        })
      }
    }

    // Ensure we have at least one range covering all targets
    if (versionRanges.length === 0) {
      return [{
        range: '>=0',
        targets,
        comment: 'Fallback: no major version boundaries detected'
      }]
    }

    // Add a catch-all range for any targets not covered by major-specific ranges
    const coveredTargets = new Set()
    versionRanges.forEach(vr => vr.targets.forEach(t => coveredTargets.add(t)))
    const uncoveredTargets = targets.filter(t => !coveredTargets.has(t))

    if (uncoveredTargets.length > 0) {
      versionRanges.unshift({
        range: '>=0',
        targets: uncoveredTargets,
        comment: 'Conservative fallback for uncovered targets'
      })
    }

    return versionRanges
  }

  function determineVersionRange (availableVersions, apiDifferences, targetKey) {
    if (availableVersions.length === 1 && availableVersions[0] === '>=0') {
      return '>=0'
    }

    // Check for breaking changes affecting this target
    const affectingChanges = apiDifferences.filter(diff =>
      diff.method === targetKey && diff.impact === 'breaking'
    )

    if (affectingChanges.length === 0) {
      // No breaking changes, use broad range
      return '>=0'
    }

    // Find the earliest version where target is available
    const sortedVersions = availableVersions
      .filter(v => v !== '>=0')
      .sort((a, b) => compareVersions(a, b))

    if (sortedVersions.length === 0) {
      return '>=0'
    }

    const earliestVersion = sortedVersions[0]
    const major = earliestVersion.split('.')[0]

    // Generate range based on major version changes
    const nextMajor = parseInt(major) + 1
    return `>=${earliestVersion} <${nextMajor}.0.0`
  }

  function compareVersions (a, b) {
    const aParts = a.split('.').map(Number)
    const bParts = b.split('.').map(Number)

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] || 0
      const bPart = bParts[i] || 0

      if (aPart < bPart) return -1
      if (aPart > bPart) return 1
    }

    return 0
  }

  function generateUnifiedChannelDeclarations (integrationId, category) {
    const lines = []
    const channels = {}

    if (category === 'web') {
      // Web frameworks use handle channel pattern
      const channelName = `apm:${integrationId}:request:handle`
      lines.push(`const handleChannel = channel('${channelName}')`)
      channels.handle = 'handleChannel'
    } else if (category === 'messaging') {
      // Messaging uses produce and receive patterns
      const produceBase = `apm:${integrationId}:produce`
      const receiveBase = `apm:${integrationId}:receive`
      lines.push(`const produceStartCh = channel('${produceBase}:start')`)
      lines.push(`const produceFinishCh = channel('${produceBase}:finish')`)
      lines.push(`const produceErrorCh = channel('${produceBase}:error')`)
      lines.push(`const receiveStartCh = channel('${receiveBase}:start')`)
      lines.push(`const receiveFinishCh = channel('${receiveBase}:finish')`)
      lines.push(`const receiveErrorCh = channel('${receiveBase}:error')`)
      channels.produce = { start: 'produceStartCh', finish: 'produceFinishCh', error: 'produceErrorCh' }
      channels.receive = { start: 'receiveStartCh', finish: 'receiveFinishCh', error: 'receiveErrorCh' }
    } else {
      // Other categories use unified start/finish/error pattern
      const base = `apm:${integrationId}:request`
      lines.push(`const requestStartCh = channel('${base}:start')`)
      lines.push(`const requestFinishCh = channel('${base}:finish')`)
      lines.push(`const requestErrorCh = channel('${base}:error')`)
      channels.request = { start: 'requestStartCh', finish: 'requestFinishCh', error: 'requestErrorCh' }
    }

    return { lines, channels }
  }

  function classifyMessagingVerb (methodName) {
    const name = String(methodName || '').toLowerCase()
    const producer = new Set(['produce', 'publish', 'send', 'enqueue', 'add'])
    const consumer = new Set(['consume', 'subscribe', 'on', 'process', 'run', 'receive'])
    if (producer.has(name)) return 'produce'
    if (consumer.has(name)) return 'receive'
    return null
  }

  const parts = []
  parts.push("'use strict'")
  parts.push('')
  parts.push("const { addHook, channel } = require('./helpers/instrument')")
  parts.push("const shimmer = require('../../datadog-shimmer')")
  parts.push('')

  // one canonical operation per top-level module
  const canonicalOp = getOperationForCategory(category)

  // unified channel declarations for the integration
  const { lines: channelLines, channels } = generateUnifiedChannelDeclarations(integrationId, category)
  parts.push(...channelLines)
  parts.push('')

  // emit per-module wrapper factories for each unique method-target combination
  const processedWrappers = new Set() // Track generated wrapper functions across all modules
  for (const [modName, targets] of byModule.entries()) {
    const uniqMethods = Array.from(new Set(targets.map(t => t.function_name))).filter(Boolean)
    for (const m of uniqMethods) {
      const MethodName = toUpperId(m)
      const methodParam = `${toId(m)}Original`

      // Create unique wrapper name per method to avoid duplicates
      const wrapperName = `makeWrap${MethodName}`
      if (processedWrappers.has(wrapperName)) {
        continue // Skip if we already generated this wrapper
      }
      processedWrappers.add(wrapperName)
      let opVar = canonicalOp
      if (category === 'messaging') {
        const kind = classifyMessagingVerb(m)
        opVar = kind === 'receive' ? 'receive' : 'produce'
      }
      if (category === 'web') {
        // Web frameworks use handleChannel.publish pattern
        parts.push(`function makeWrap${MethodName} () {`)
        parts.push(`  return function wrap${MethodName} (${methodParam}) {`)
        parts.push('    return function wrapped () {')
        parts.push(`      if (!${channels.handle}.hasSubscribers) {`)
        parts.push(`        return ${methodParam}.apply(this, arguments)`)
        parts.push('      }')
        parts.push('      // TODO: add relevant context fields (req, res, route, etc.)')
        parts.push('      const ctx = { req: arguments[0] }')
        parts.push(`      ${channels.handle}.publish(ctx)`)
        parts.push(`      return ${methodParam}.apply(this, arguments)`)
        parts.push('    }')
        parts.push('  }')
        parts.push('}')
      } else {
        // Other categories use unified start/finish/error pattern
        const channelGroup = category === 'messaging' ? channels[opVar] : channels.request
        parts.push(`function makeWrap${MethodName} () {`)
        parts.push(`  return function wrap${MethodName} (${methodParam}) {`)
        parts.push('    return function wrapped () {')
        parts.push(`      if (!${channelGroup.start}.hasSubscribers) {`)
        parts.push(`        return ${methodParam}.apply(this, arguments)`)
        parts.push('      }')
        // Find the target data for this method to generate context extraction
        const targetForMethod = selected.find(t =>
          t.function_name === m &&
          (t.module === modName || t.module === npmName || !t.module)
        )

        if (targetForMethod && report) {
          const extractionLines = generateContextExtractionCode(targetForMethod, `${category}-client`)
          parts.push('      const ctx = {}')
          parts.push(...extractionLines)
        } else {
          parts.push('      // TODO: add relevant context fields (resource, params,')
          parts.push('      // connection info, etc.)')
          parts.push('      const ctx = {}')
        }
        parts.push(`      return ${channelGroup.start}.runStores(ctx, () => {`)
        parts.push('        try {')
        parts.push(`          const result = ${methodParam}.apply(this, arguments)`)
        parts.push(`          ${channelGroup.finish}.publish(ctx)`)
        parts.push('          return result')
        parts.push('        } catch (error) {')
        parts.push('          ctx.error = error')
        parts.push(`          ${channelGroup.error}.publish(ctx)`)
        parts.push('          throw error')
        parts.push('        }')
        parts.push('      })')
        parts.push('    }')
        parts.push('  }')
        parts.push('}')
      }
    }
    parts.push('')
  }

  // emit addHook blocks per file using the factories with version awareness
  for (const [modName, targets] of byModule.entries()) {
    // Generate version-aware groupings
    const versionRanges = generateVersionRanges(versionAnalysis, targets)

    for (const { range, targets: versionTargets } of versionRanges) {
      const byFile = new Map()
      for (const t of versionTargets) {
        const fileKey = t.file || t.file_path || t.source || ''
        const exp = t.export_name || 'default'
        const method = t.function_name
        if (!byFile.has(fileKey)) byFile.set(fileKey, new Map())
        const expMap = byFile.get(fileKey)
        if (!expMap.has(exp)) expMap.set(exp, new Set())
        expMap.get(exp).add(method)
      }

      for (const [fileKey, expMap] of byFile.entries()) {
        const fileOpt = fileKey ? `, file: '${fileKey}'` : ''
        const moduleParam = modVarName(modName)
        const versionComment = versionTargets.comment ? ` // ${versionTargets.comment}` : ''
        parts.push(`addHook({ name: '${npmName}'${fileOpt}, versions: ['${range}'] }, (${moduleParam}) => {${versionComment}`)
        for (const [exp, methods] of expMap.entries()) {
          // Build target with dot-notation per segment when possible
          let targetExpr = moduleParam
          if (exp !== 'default') {
            const segs = String(exp).split('.')
            for (const seg of segs) {
              targetExpr += isIdentifier(seg) ? `.${seg}` : `['${seg}']`
            }
          }

          // Generate unique variable name for each export to avoid conflicts
          // Use only the last segment to keep names short
          const lastSegment = exp.split('.').pop() || 'target'
          const targetVarName = exp === 'default' ? 'target' : `target${lastSegment.replace(/[^a-zA-Z0-9]/g, '').replace(/^\w/, c => c.toUpperCase())}`

          parts.push('  // TODO: if methods live on a prototype, set target to')
          parts.push('  // target.prototype; otherwise use export directly')
          parts.push('  // Conservative approach: try multiple target patterns for version compatibility')
          parts.push(`  const ${targetVarName} = ${targetExpr}`)

          // Add runtime detection for different API patterns if we have version analysis
          if (versionAnalysis && exp !== 'default') {
            parts.push('  // Fallback target detection for different versions')
            parts.push(`  const fallbackTarget = ${moduleParam}.default?.prototype || ${moduleParam}.prototype || ${moduleParam}`)
          }
          const uniqMethods = Array.from(new Set(Array.from(methods))).filter(Boolean)
          for (const m of uniqMethods) {
            const MethodName = toUpperId(m)
            const typeOfExpr = isIdentifier(m) ? `typeof ${targetVarName}.${m}` : `typeof ${targetVarName}['${m}']`

            if (versionAnalysis && exp !== 'default') {
              // Enhanced version-aware method detection
              const fallbackTypeOfExpr = isIdentifier(m) ? `typeof fallbackTarget.${m}` : `typeof fallbackTarget['${m}']`
              parts.push(`  if (${targetVarName} && ${typeOfExpr} === 'function') {`)
              parts.push(`    shimmer.wrap(${targetVarName}, '${m}', makeWrap${MethodName}())`)
              parts.push(`  } else if (fallbackTarget && ${fallbackTypeOfExpr} === 'function') {`)
              parts.push(`    shimmer.wrap(fallbackTarget, '${m}', makeWrap${MethodName}())`)
              parts.push('  }')
            } else {
              // Standard method detection
              parts.push(`  if (${targetVarName} && ${typeOfExpr} === 'function') {`)
              parts.push(`    shimmer.wrap(${targetVarName}, '${m}', makeWrap${MethodName}())`)
              parts.push('  }')
            }
          }
        }
        parts.push(`  return ${moduleParam}`)
        parts.push('})')
        parts.push('')
      }
    }
  }

  return parts.join('\n') + '\n'
}

module.exports = { generateInstrumentationFile }
