'use strict'

const iastLog = require('../../iast-log')
const vulnerabilities = require('../../vulnerabilities')

const { contains, intersects, remove } = require('./range-utils')

const commandSensitiveAnalyzer = require('./sensitive-analyzers/command-sensitive-analyzer')
const hardcodedPasswordAnalyzer = require('./sensitive-analyzers/hardcoded-password-analyzer')
const headerSensitiveAnalyzer = require('./sensitive-analyzers/header-sensitive-analyzer')
const jsonSensitiveAnalyzer = require('./sensitive-analyzers/json-sensitive-analyzer')
const ldapSensitiveAnalyzer = require('./sensitive-analyzers/ldap-sensitive-analyzer')
const sqlSensitiveAnalyzer = require('./sensitive-analyzers/sql-sensitive-analyzer')
const urlSensitiveAnalyzer = require('./sensitive-analyzers/url-sensitive-analyzer')

const { DEFAULT_IAST_REDACTION_NAME_PATTERN, DEFAULT_IAST_REDACTION_VALUE_PATTERN } = require('./sensitive-regex')

const REDACTED_SOURCE_BUFFER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

class SensitiveHandler {
  constructor () {
    this._namePattern = new RegExp(DEFAULT_IAST_REDACTION_NAME_PATTERN, 'gmi')
    this._valuePattern = new RegExp(DEFAULT_IAST_REDACTION_VALUE_PATTERN, 'gmi')

    this._sensitiveAnalyzers = new Map()
    this._sensitiveAnalyzers.set(vulnerabilities.COMMAND_INJECTION, commandSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.NOSQL_MONGODB_INJECTION, jsonSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.LDAP_INJECTION, ldapSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.SQL_INJECTION, sqlSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.SSRF, urlSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.UNVALIDATED_REDIRECT, urlSensitiveAnalyzer)
    this._sensitiveAnalyzers.set(vulnerabilities.HEADER_INJECTION, (evidence) => {
      return headerSensitiveAnalyzer(evidence, this._namePattern, this._valuePattern)
    })
    this._sensitiveAnalyzers.set(vulnerabilities.HARDCODED_PASSWORD, (evidence) => {
      return hardcodedPasswordAnalyzer(evidence, this._valuePattern)
    })
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
      const sensitiveRanges = sensitiveAnalyzer(evidence)
      if (evidence.ranges || sensitiveRanges?.length) {
        return this.toRedactedJson(evidence, sensitiveRanges, sourcesIndexes, sources)
      }
    }
    return null
  }

  toRedactedJson (evidence, sensitive, sourcesIndexes, sources) {
    const valueParts = []
    const redactedSources = []
    const redactedSourcesContext = []

    const { value, ranges } = evidence

    let start = 0
    let nextTaintedIndex = 0
    let sourceIndex

    let nextTainted = ranges?.shift()
    let nextSensitive = sensitive.shift()

    for (let i = 0; i < value.length; i++) {
      if (nextTainted != null && nextTainted.start === i) {
        this.writeValuePart(valueParts, value.substring(start, i), sourceIndex)

        sourceIndex = sourcesIndexes[nextTaintedIndex]

        while (nextSensitive != null && contains(nextTainted, nextSensitive)) {
          const redactionStart = nextSensitive.start - nextTainted.start
          const redactionEnd = nextSensitive.end - nextTainted.start
          if (redactionStart === redactionEnd) {
            this.writeRedactedValuePart(valueParts, 0)
          } else {
            this.redactSource(
              sources,
              redactedSources,
              redactedSourcesContext,
              sourceIndex,
              redactionStart,
              redactionEnd
            )
          }
          nextSensitive = sensitive.shift()
        }

        if (nextSensitive != null && intersects(nextSensitive, nextTainted)) {
          const redactionStart = nextSensitive.start - nextTainted.start
          const redactionEnd = nextSensitive.end - nextTainted.start
          this.redactSource(sources, redactedSources, redactedSourcesContext, sourceIndex, redactionStart, redactionEnd)

          const entries = remove(nextSensitive, nextTainted)
          nextSensitive = entries.length > 0 ? entries[0] : null
        }

        if (this.isSensibleSource(sources[sourceIndex])) {
          if (!sources[sourceIndex].redacted) {
            redactedSources.push(sourceIndex)
            sources[sourceIndex].pattern = ''.padEnd(sources[sourceIndex].value.length, REDACTED_SOURCE_BUFFER)
            sources[sourceIndex].redacted = true
          }
        }

        if (redactedSources.indexOf(sourceIndex) > -1) {
          const partValue = value.substring(i, i + (nextTainted.end - nextTainted.start))
          this.writeRedactedValuePart(
            valueParts,
            partValue.length,
            sourceIndex,
            partValue,
            sources[sourceIndex],
            redactedSourcesContext[sourceIndex],
            this.isSensibleSource(sources[sourceIndex])
          )
          redactedSourcesContext[sourceIndex] = []
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

          const redactionStart = nextSensitive.start - nextTainted.start
          const redactionEnd = nextSensitive.end - nextTainted.start
          this.redactSource(sources, redactedSources, redactedSourcesContext, sourceIndex, redactionStart, redactionEnd)

          for (const entry of remove(nextSensitive, nextTainted)) {
            if (entry.start === i) {
              nextSensitive = entry
            } else {
              sensitive.unshift(entry)
            }
          }
        }

        const _length = nextSensitive.end - nextSensitive.start
        this.writeRedactedValuePart(valueParts, _length)

        start = i + _length
        i = start - 1
        nextSensitive = sensitive.shift()
      }
    }

    if (start < value.length) {
      this.writeValuePart(valueParts, value.substring(start))
    }

    return { redactedValueParts: valueParts, redactedSources }
  }

  redactSource (sources, redactedSources, redactedSourcesContext, sourceIndex, start, end) {
    if (sourceIndex != null) {
      if (!sources[sourceIndex].redacted) {
        redactedSources.push(sourceIndex)
        sources[sourceIndex].pattern = ''.padEnd(sources[sourceIndex].value.length, REDACTED_SOURCE_BUFFER)
        sources[sourceIndex].redacted = true
      }

      if (!redactedSourcesContext[sourceIndex]) {
        redactedSourcesContext[sourceIndex] = []
      }
      redactedSourcesContext[sourceIndex].push({
        start,
        end
      })
    }
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

  writeRedactedValuePart (
    valueParts,
    length,
    sourceIndex,
    partValue,
    source,
    sourceRedactionContext,
    isSensibleSource
  ) {
    if (sourceIndex != null) {
      const placeholder = source.value.includes(partValue)
        ? source.pattern
        : '*'.repeat(length)

      if (isSensibleSource) {
        valueParts.push({ redacted: true, source: sourceIndex, pattern: placeholder })
      } else {
        let _value = partValue
        const dedupedSourceRedactionContexts = []

        sourceRedactionContext.forEach(_sourceRedactionContext => {
          const isPresentInDeduped = dedupedSourceRedactionContexts.some(_dedupedSourceRedactionContext =>
            _dedupedSourceRedactionContext.start === _sourceRedactionContext.start &&
            _dedupedSourceRedactionContext.end === _sourceRedactionContext.end
          )

          if (!isPresentInDeduped) {
            dedupedSourceRedactionContexts.push(_sourceRedactionContext)
          }
        })

        let offset = 0
        dedupedSourceRedactionContexts.forEach((_sourceRedactionContext) => {
          if (_sourceRedactionContext.start > 0) {
            valueParts.push({
              source: sourceIndex,
              value: _value.substring(0, _sourceRedactionContext.start - offset)
            })

            _value = _value.substring(_sourceRedactionContext.start - offset)
            offset = _sourceRedactionContext.start
          }

          const sensitive =
            _value.substring(_sourceRedactionContext.start - offset, _sourceRedactionContext.end - offset)
          const indexOfPartValueInPattern = source.value.indexOf(sensitive)

          const pattern = indexOfPartValueInPattern > -1
            ? placeholder.substring(indexOfPartValueInPattern, indexOfPartValueInPattern + sensitive.length)
            : placeholder.substring(_sourceRedactionContext.start, _sourceRedactionContext.end)

          valueParts.push({
            redacted: true,
            source: sourceIndex,
            pattern
          })

          _value = _value.substring(pattern.length)
          offset += pattern.length
        })

        if (_value.length) {
          valueParts.push({
            source: sourceIndex,
            value: _value
          })
        }
      }
    } else {
      valueParts.push({ redacted: true })
    }
  }

  setRedactionPatterns (redactionNamePattern, redactionValuePattern) {
    if (redactionNamePattern) {
      try {
        this._namePattern = new RegExp(redactionNamePattern, 'gmi')
      } catch (e) {
        iastLog.warn('Redaction name pattern is not valid')
      }
    }

    if (redactionValuePattern) {
      try {
        this._valuePattern = new RegExp(redactionValuePattern, 'gmi')
      } catch (e) {
        iastLog.warn('Redaction value pattern is not valid')
      }
    }
  }
}

module.exports = new SensitiveHandler()
