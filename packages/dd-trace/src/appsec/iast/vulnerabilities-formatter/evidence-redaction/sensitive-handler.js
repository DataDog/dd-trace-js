'use strict'

const vulnerabilities = require('../../vulnerabilities')

const { contains, intersects, remove } = require('./range-utils')

const CommandSensitiveAnalyzer = require('./sensitive-analyzers/command-sensitive-analyzer')
const LdapSensitiveAnalyzer = require('./sensitive-analyzers/ldap-sensitive-analyzer')
const SqlSensitiveAnalyzer = require('./sensitive-analyzers/sql-sensitive-analyzer')
const UrlSensitiveAnalyzer = require('./sensitive-analyzers/url-sensitive-analyzer')

// eslint-disable-next-line max-len
const DEFAULT_IAST_REDACTION_NAME_PATTERN = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)'
// eslint-disable-next-line max-len
const DEFAULT_IAST_REDACTION_VALUE_PATTERN = '(?:bearer\\s+[a-z0-9\\._\\-]+|glpat-[\\w\\-]{20}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=\\-]+\\.ey[I-L][\\w=\\-]+(?:\\.[\\w.+/=\\-]+)?|(?:[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY[\\-]{5}|ssh-rsa\\s*[a-z0-9/\\.+]{100,}))'

class SensitiveHandler {
  constructor () {
    this._namePattern = new RegExp(DEFAULT_IAST_REDACTION_NAME_PATTERN, 'gmi')
    this._valuePattern = new RegExp(DEFAULT_IAST_REDACTION_VALUE_PATTERN, 'gmi')

    this._sensitiveAnalyzers = new Map()
    this._sensitiveAnalyzers.set(vulnerabilities.COMMAND_INJECTION, new CommandSensitiveAnalyzer())
    this._sensitiveAnalyzers.set(vulnerabilities.LDAP_INJECTION, new LdapSensitiveAnalyzer())
    this._sensitiveAnalyzers.set(vulnerabilities.SQL_INJECTION, new SqlSensitiveAnalyzer())
    this._sensitiveAnalyzers.set(vulnerabilities.SSRF, new UrlSensitiveAnalyzer())
  }

  isSensibleName (name) {
    this._namePattern.lastIndex = 0
    return this._namePattern.test(name)
  }

  isSensibleValue (value) {
    this._valuePattern.lastIndex = 0
    return this._valuePattern.test(value)
  }

  isSensibleSource (source) {
    return source != null && (this.isSensibleName(source.name) || this.isSensibleValue(source.value))
  }

  scrubEvidence (vulnerabilityType, evidence, sourcesIndexes, sources) {
    const sensitiveAnalyzer = this._sensitiveAnalyzers.get(vulnerabilityType)
    if (sensitiveAnalyzer) {
      const sensitiveRanges = sensitiveAnalyzer.extractSensitiveRanges(evidence)
      return this.toRedactedJson(evidence, sensitiveRanges, sourcesIndexes, sources)
    }
    return null
  }

  toRedactedJson (evidence, sensitive, sourcesIndexes, sources) {
    const valueParts = []
    const redactedSources = []

    const { value, ranges } = evidence

    let start = 0
    let nextTaintedIndex = 0
    let sourceIndex

    let nextTainted = ranges.shift()
    let nextSensitive = sensitive.shift()

    for (let i = 0; i < value.length; i++) {
      if (nextTainted != null && nextTainted.start === i) {
        this.writeValuePart(valueParts, value.substring(start, i), sourceIndex)

        sourceIndex = sourcesIndexes[nextTaintedIndex]

        while (nextSensitive != null && contains(nextTainted, nextSensitive)) {
          sourceIndex != null && redactedSources.push(sourceIndex)
          nextSensitive = sensitive.shift()
        }

        if (nextSensitive != null && intersects(nextSensitive, nextTainted)) {
          sourceIndex != null && redactedSources.push(sourceIndex)

          const entries = remove(nextSensitive, nextTainted)
          nextSensitive = entries.length > 0 ? entries[0] : null
        }

        this.isSensibleSource(sources[sourceIndex]) && redactedSources.push(sourceIndex)

        if (redactedSources.indexOf(sourceIndex) > -1) {
          this.writeRedactedValuePart(valueParts, sourceIndex)
        } else {
          const substringEnd = Math.min(nextTainted.end, value.length)
          this.writeValuePart(valueParts, value.substring(nextTainted.start, substringEnd), sourceIndex)
        }

        start = i + (nextTainted.end - nextTainted.start)
        i = start - 1
        nextTainted = ranges.shift()
        nextTaintedIndex++
        sourceIndex = null
      } else if (nextSensitive != null && nextSensitive.start === i) {
        this.writeValuePart(valueParts, value.substring(start, i), sourceIndex)
        if (nextTainted != null && intersects(nextSensitive, nextTainted)) {
          sourceIndex = sourcesIndexes[nextTaintedIndex]
          sourceIndex != null && redactedSources.push(sourceIndex)

          for (const entry of remove(nextSensitive, nextTainted)) {
            if (entry.start === i) {
              nextSensitive = entry
            } else {
              sensitive.unshift(entry)
            }
          }
        }

        this.writeRedactedValuePart(valueParts)

        start = i + (nextSensitive.end - nextSensitive.start)
        i = start - 1
        nextSensitive = sensitive.shift()
      }
    }

    if (start < value.length) {
      this.writeValuePart(valueParts, value.substring(start))
    }

    return { redactedValueParts: valueParts, redactedSources }
  }

  writeValuePart (valueParts, value, source) {
    if (value.length > 0) {
      if (source != null) {
        valueParts.push({ value, source })
      } else {
        valueParts.push({ value })
      }
    }
  }

  writeRedactedValuePart (valueParts, source) {
    if (source != null) {
      valueParts.push({ redacted: true, source })
    } else {
      valueParts.push({ redacted: true })
    }
  }
}

module.exports = new SensitiveHandler()
