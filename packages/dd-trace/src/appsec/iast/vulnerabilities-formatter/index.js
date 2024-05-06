'use strict'

const sensitiveHandler = require('./evidence-redaction/sensitive-handler')
const { stringifyWithRanges } = require('./utils')

class VulnerabilityFormatter {
  constructor () {
    this._redactVulnearbilities = true
  }

  setRedactVulnerabilities (shouldRedactVulnerabilities, redactionNamePattern, redactionValuePattern) {
    this._redactVulnearbilities = shouldRedactVulnerabilities
    sensitiveHandler.setRedactionPatterns(redactionNamePattern, redactionValuePattern)
  }

  extractSourcesFromVulnerability (vulnerability) {
    if (!vulnerability.evidence.ranges) {
      return []
    }
    return vulnerability.evidence.ranges.map(range => (
      {
        origin: range.iinfo.type,
        name: range.iinfo.parameterName,
        value: range.iinfo.parameterValue
      }
    ))
  }

  getRedactedValueParts (type, evidence, sourcesIndexes, sources) {
    const scrubbingResult = sensitiveHandler.scrubEvidence(type, evidence, sourcesIndexes, sources)
    if (scrubbingResult) {
      const { redactedValueParts, redactedSources } = scrubbingResult
      redactedSources.forEach(i => {
        delete sources[i].value
      })
      return { valueParts: redactedValueParts }
    }

    return this.getUnredactedValueParts(evidence, sourcesIndexes)
  }

  getUnredactedValueParts (evidence, sourcesIndexes) {
    const valueParts = []
    let fromIndex = 0

    if (typeof evidence.value === 'object' && evidence.rangesToApply) {
      const { value, ranges } = stringifyWithRanges(evidence.value, evidence.rangesToApply)
      evidence.value = value
      evidence.ranges = ranges
    }

    if (!evidence.ranges) {
      return { value: evidence.value }
    }

    evidence.ranges.forEach((range, rangeIndex) => {
      if (fromIndex < range.start) {
        valueParts.push({ value: evidence.value.substring(fromIndex, range.start) })
      }
      valueParts.push({ value: evidence.value.substring(range.start, range.end), source: sourcesIndexes[rangeIndex] })
      fromIndex = range.end
    })

    if (fromIndex < evidence.value.length) {
      valueParts.push({ value: evidence.value.substring(fromIndex) })
    }

    return { valueParts }
  }

  formatEvidence (type, evidence, sourcesIndexes, sources) {
    if (typeof evidence.value === 'undefined') {
      return undefined
    }

    return this._redactVulnearbilities
      ? this.getRedactedValueParts(type, evidence, sourcesIndexes, sources)
      : this.getUnredactedValueParts(evidence, sourcesIndexes)
  }

  formatVulnerability (vulnerability, sourcesIndexes, sources) {
    const formattedVulnerability = {
      type: vulnerability.type,
      hash: vulnerability.hash,
      evidence: this.formatEvidence(vulnerability.type, vulnerability.evidence, sourcesIndexes, sources),
      location: {
        spanId: vulnerability.location.spanId
      }
    }
    if (vulnerability.location.path) {
      formattedVulnerability.location.path = vulnerability.location.path
    }
    if (vulnerability.location.line) {
      formattedVulnerability.location.line = vulnerability.location.line
    }
    return formattedVulnerability
  }

  toJson (vulnerabilitiesToFormat) {
    const sources = []

    const vulnerabilities = vulnerabilitiesToFormat.map(vulnerability => {
      const vulnerabilitySources = this.extractSourcesFromVulnerability(vulnerability)
      const sourcesIndexes = []
      vulnerabilitySources.forEach((source) => {
        let sourceIndex = sources.findIndex(
          existingSource =>
            existingSource.origin === source.origin &&
            existingSource.name === source.name &&
            existingSource.value === source.value
        )
        if (sourceIndex === -1) {
          sourceIndex = sources.length
          sources.push(source)
        }
        sourcesIndexes.push(sourceIndex)
      })

      return this.formatVulnerability(vulnerability, sourcesIndexes, sources)
    })

    return {
      sources,
      vulnerabilities
    }
  }
}

module.exports = new VulnerabilityFormatter()
