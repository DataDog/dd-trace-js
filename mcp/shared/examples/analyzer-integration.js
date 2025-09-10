'use strict'

/**
 * Example: Using generic data requirements in the analyzer
 *
 * This shows how the analyzer can use the generic data requirements
 * to score instrumentation targets based on their data availability.
 */

const { getDataRequirements, getSupportedIntegrationTypes } = require('../apm-data-requirements')

/**
 * Enhanced version of the analyzer's data scoring function
 * Now uses the generic data requirements specification
 */
function scoreDataAvailability (target, category, subcategory) {
  const integrationType = `${category}-${subcategory}`
  const requirements = getDataRequirements(integrationType)

  if (!requirements) {
    return {
      score: 0.5, // Neutral score for unknown types
      breakdown: {},
      reasoning: `No data requirements defined for ${integrationType}`,
      supportedTypes: getSupportedIntegrationTypes()
    }
  }

  const breakdown = {}
  let totalScore = 0
  let maxPossibleScore = 0

  // Analyze each requirement category using generic weights
  const weights = { critical: 1.0, important: 0.7, optional: 0.3 }

  for (const [priority, dataTypes] of Object.entries(requirements)) {
    const weight = weights[priority]
    breakdown[priority] = {}

    for (const [dataType, spec] of Object.entries(dataTypes)) {
      maxPossibleScore += weight
      const availability = analyzeDataAvailabilityWithSources(target, spec)
      const score = availability.score * weight
      totalScore += score

      breakdown[priority][dataType] = {
        available: availability.available,
        confidence: availability.confidence,
        spanFields: spec.span_fields, // Include expected span field names
        dataSources: spec.data_sources || [], // Include data source information
        matchedSources: availability.matchedSources || [],
        extractionHints: availability.extractionHints || [],
        recommendedSource: availability.recommendedSource,
        patterns: availability.matchedPatterns || [],
        score,
        weight,
        extractionGuide: generateExtractionGuide(spec.data_sources || [])
      }
    }
  }

  const finalScore = maxPossibleScore > 0 ? totalScore / maxPossibleScore : 0

  return {
    score: Math.min(1.0, Math.max(0.0, finalScore)),
    breakdown,
    reasoning: generateScoreReasoning(breakdown, finalScore),
    integrationType,
    expectedSpanFields: extractExpectedSpanFields(requirements)
  }
}

/**
 * Analyze data availability based on generic specification
 */
function analyzeDataAvailabilityFromSpec (target, spec) {
  const functionName = target.function_name || ''
  const exportPath = target.export_path || ''

  // Use description and examples from spec for pattern matching
  const description = spec.description.toLowerCase()
  const examples = spec.examples || []

  // Extract keywords from description and examples
  const keywords = extractKeywordsFromSpec(spec)

  // Check if function name indicates data availability
  const nameMatches = keywords.some(keyword =>
    functionName.toLowerCase().includes(keyword.toLowerCase()) ||
    exportPath.toLowerCase().includes(keyword.toLowerCase())
  )

  let confidence = 0
  const matchedPatterns = []

  if (nameMatches) {
    confidence += 0.4
    matchedPatterns.push(...keywords.filter(keyword =>
      functionName.toLowerCase().includes(keyword.toLowerCase()) ||
      exportPath.toLowerCase().includes(keyword.toLowerCase())
    ))
  }

  // Boost confidence based on validation requirements
  if (spec.validation?.required) {
    confidence += 0.2 // Required fields get priority
  }

  // Consider expected span field names for additional context
  const spanFieldKeywords = spec.span_fields.map(field =>
    field.split('.').pop().replace(/\*/g, '')
  )

  const spanFieldMatches = spanFieldKeywords.some(keyword =>
    functionName.toLowerCase().includes(keyword.toLowerCase())
  )

  if (spanFieldMatches) {
    confidence += 0.3
  }

  return {
    available: confidence > 0.3,
    confidence: Math.min(1.0, confidence),
    score: Math.min(1.0, confidence),
    matchedPatterns,
    spanFieldHints: spanFieldKeywords
  }
}

/**
 * Extract keywords from data requirement specification
 */
function extractKeywordsFromSpec (spec) {
  const keywords = []

  // Extract from description
  const descWords = spec.description.toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 3)
  keywords.push(...descWords)

  // Extract from span field names
  spec.span_fields.forEach(field => {
    const parts = field.split('.')
    keywords.push(...parts.filter(part => part !== '*' && part.length > 2))
  })

  // Extract from examples if they're strings
  if (spec.examples) {
    spec.examples.forEach(example => {
      if (typeof example === 'string') {
        // Extract meaningful parts from URLs, queries, etc.
        const parts = example.split(/[\/\.\?\&\s]+/)
        keywords.push(...parts.filter(part => part.length > 2))
      }
    })
  }

  return [...new Set(keywords)] // Remove duplicates
}

/**
 * Extract expected span fields from requirements
 */
function extractExpectedSpanFields (requirements) {
  const fields = {}

  for (const [priority, dataTypes] of Object.entries(requirements)) {
    for (const [dataType, spec] of Object.entries(dataTypes)) {
      fields[dataType] = {
        priority,
        spanFields: spec.span_fields,
        required: spec.validation?.required || priority === 'critical',
        type: spec.validation?.type || 'string'
      }
    }
  }

  return fields
}

/**
 * Generate reasoning with span field context
 */
function generateScoreReasoning (breakdown, score) {
  const reasons = []

  for (const [priority, dataTypes] of Object.entries(breakdown)) {
    const available = Object.values(dataTypes).filter(d => d.available).length
    const total = Object.keys(dataTypes).length

    if (available > 0) {
      const fields = Object.entries(dataTypes)
        .filter(([, data]) => data.available)
        .map(([name]) => name)
        .join(', ')
      reasons.push(`${available}/${total} ${priority} data types available (${fields})`)
    }
  }

  if (reasons.length === 0) {
    return 'Limited data availability detected for meaningful spans'
  }

  return reasons.join(', ') + ` (overall score: ${(score * 100).toFixed(0)}%)`
}

/**
 * Generate extraction guide from data sources
 */
function generateExtractionGuide (dataSources) {
  if (!dataSources || dataSources.length === 0) {
    return { primary: 'No extraction guide available', alternatives: [] }
  }

  const guide = {
    primary: '',
    alternatives: [],
    complexity: 'simple'
  }

  // Find the most common/simple extraction method
  const primarySource = dataSources[0]
  guide.primary = formatExtractionInstruction(primarySource)

  // Add alternative methods
  guide.alternatives = dataSources.slice(1).map(source => ({
    method: formatExtractionInstruction(source),
    description: source.description,
    examples: source.examples || []
  }))

  // Determine complexity
  if (dataSources.length > 3) {
    guide.complexity = 'complex'
  } else if (dataSources.some(s => s.type === 'constructed_url' || s.type === 'callback_argument')) {
    guide.complexity = 'moderate'
  }

  return guide
}

/**
 * Format extraction instruction for a data source
 */
function formatExtractionInstruction (source) {
  switch (source.type) {
    case 'argument':
      return `Extract from argument ${source.position} (${source.format})`

    case 'argument_property':
      return `Extract from args[${source.position}].${source.property} (${source.format})`

    case 'function_name':
      return `Derive from function name (${source.format})`

    case 'method_name':
      return `Derive from method name (${source.format})`

    case 'response_property':
      return `Extract from response.${source.property} (${source.format})`

    case 'callback_argument':
      return `Extract from callback argument ${source.position}.${source.property || ''} (${source.format})`

    case 'url_component':
      return `Extract ${source.component} from URL (${source.format})`

    case 'constructed_url':
      return `Construct from components: ${source.components.join(', ')}`

    case 'module_name':
      return `Derive from module name (${source.format})`

    case 'connection_property':
      return `Extract from connection.${source.property} (${source.format})`

    case 'class_name':
      return `Derive from class name (${source.format})`

    case 'default_value':
      return `Use default value: ${source.value}`

    default:
      return `Extract using ${source.type} method (${source.format})`
  }
}

/**
 * Analyze data availability with enhanced source matching
 */
function analyzeDataAvailabilityWithSources (target, spec) {
  const functionName = target.function_name || ''
  const exportPath = target.export_path || ''
  const module = target.module || ''

  let confidence = 0
  const matchedSources = []
  const extractionHints = []

  // Analyze each data source for availability
  if (spec.data_sources) {
    for (const source of spec.data_sources) {
      const sourceMatch = analyzeSourceAvailability(target, source)
      if (sourceMatch.available) {
        confidence += sourceMatch.confidence
        matchedSources.push(source)
        extractionHints.push(sourceMatch.hint)
      }
    }
  }

  // Normalize confidence (max 1.0)
  confidence = Math.min(1.0, confidence)

  return {
    available: confidence > 0.3,
    confidence,
    score: confidence,
    matchedSources,
    extractionHints,
    recommendedSource: matchedSources[0] || null
  }
}

/**
 * Analyze if a specific data source is available for a target
 */
function analyzeSourceAvailability (target, source) {
  const functionName = target.function_name || ''
  const exportPath = target.export_path || ''

  let confidence = 0
  let hint = ''

  switch (source.type) {
    case 'argument':
      // High confidence for functions that typically take arguments
      if (['get', 'post', 'put', 'delete', 'query', 'execute', 'find'].some(verb =>
        functionName.toLowerCase().includes(verb))) {
        confidence = 0.8
        hint = `Function ${functionName} likely accepts arguments`
      } else {
        confidence = 0.4
        hint = `Function ${functionName} may accept arguments`
      }
      break

    case 'function_name':
      // Check if function name contains relevant keywords
      if (source.examples && source.examples.some(example =>
        example.toLowerCase().includes(functionName.toLowerCase()))) {
        confidence = 0.9
        hint = `Function name ${functionName} directly indicates data availability`
      }
      break

    case 'argument_property':
      // Medium confidence for functions that take options objects
      if (['request', 'query', 'execute', 'connect'].some(verb =>
        functionName.toLowerCase().includes(verb))) {
        confidence = 0.7
        hint = `Function ${functionName} likely accepts options object with ${source.property}`
      }
      break

    case 'response_property':
      // Only available if this is a response-handling function
      if (['then', 'callback', 'response', 'result'].some(keyword =>
        functionName.toLowerCase().includes(keyword))) {
        confidence = 0.6
        hint = `Function ${functionName} may handle response objects`
      }
      break

    case 'module_name':
      // Available if we can derive from module context
      confidence = 0.5
      hint = 'Module name available from instrumentation context'
      break

    default:
      confidence = 0.3
      hint = `${source.type} extraction method may be available`
  }

  return {
    available: confidence > 0.2,
    confidence: confidence * 0.5, // Scale down individual source confidence
    hint
  }
}

module.exports = {
  scoreDataAvailability,
  analyzeDataAvailabilityFromSpec,
  analyzeDataAvailabilityWithSources,
  extractKeywordsFromSpec,
  extractExpectedSpanFields,
  generateExtractionGuide,
  formatExtractionInstruction
}
