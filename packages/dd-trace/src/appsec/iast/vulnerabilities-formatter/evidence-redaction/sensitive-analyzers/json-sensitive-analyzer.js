'use strict'

const JSON_OBJECT_START = '{'
const JSON_OBJECT_END = '}'
const JSON_ARRAY_START = '['
const JSON_ARRAY_END = ']'
const JSON_COLON = ':'
const JSON_STRING = '"'
const JSON_ESCAPE = '\\'
const JSON_COMMA = ','
const JSON_LINE = '\n'

const JSON_VALUE_FINISHERS = [JSON_OBJECT_END, JSON_ARRAY_END, JSON_COMMA, JSON_LINE]

const JSON_PARSER_STATUS_STARTING = 0
const JSON_PARSER_STATUS_FINDING_KEY = 1
const JSON_PARSER_STATUS_READING_KEY = 2
const JSON_PARSER_STATUS_FINDING_VALUE = 3
const JSON_PARSER_STATUS_READING_VALUE = 4
const JSON_PARSER_STATUS_READING_STRING_VALUE = 5
const JSON_PARSER_STATUS_FINDING_COLON = 6

const JSON_STRUCT_OBJECT = 0
const JSON_STRUCT_ARRAY = 1

// eslint-disable-next-line max-len
const DEFAULT_IAST_REDACTION_VALUE_PATTERN = 'bearer\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(\\.[\\w.+\\/=-]+)?|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}'

class JsonSensitiveAnalyzer {

  constructor () {
    this._valuePattern = new RegExp(DEFAULT_IAST_REDACTION_VALUE_PATTERN, 'gmi')
  }
  extractSensitiveRanges (evidence) {
    const jsonString = evidence.value
    const { keys, values } = this._getKeysAndValuesIndexLists(jsonString)
    const sensitiveRanges = [...values]
    keys.forEach(({ start, end }) => {
      const keyValue = jsonString.substring(start, end)
      this._valuePattern.lastIndex = 0
      if (this._valuePattern.test(keyValue)) {
        sensitiveRanges.push({ start, end })
      }
    })
    sensitiveRanges.sort((a, b) => {
      return a.start - b.start
    })
    return sensitiveRanges
  }

  _getKeysAndValuesIndexLists (jsonString) {
    const keys = []
    const values = []

    let status = JSON_PARSER_STATUS_STARTING
    let currentChar
    let previousChar
    let key = null
    let value = null
    let currentStruct = null
    const structsPool = []
    for (let i = 0; i < jsonString.length; i++) {
      previousChar = currentChar
      currentChar = jsonString[i]
      switch (status) {
        case JSON_PARSER_STATUS_STARTING:
          if (currentChar === JSON_OBJECT_START) {
            status = JSON_PARSER_STATUS_FINDING_KEY
            currentStruct = JSON_STRUCT_OBJECT
          } else if (currentChar === JSON_ARRAY_START) {
            status = JSON_PARSER_STATUS_FINDING_VALUE
            currentStruct = JSON_STRUCT_ARRAY
          }
          break
        case JSON_PARSER_STATUS_FINDING_KEY:
          if (currentChar === JSON_STRING) {
            status = JSON_PARSER_STATUS_READING_KEY
          } else if (currentChar === JSON_OBJECT_END) {
            currentStruct = structsPool.pop()
            if (currentStruct === JSON_STRUCT_ARRAY) {
              status = JSON_PARSER_STATUS_FINDING_VALUE
            }
          }
          break
        case JSON_PARSER_STATUS_READING_KEY:
          if (!key) {
            key = { start: i }
          }
          if (currentChar === JSON_STRING && previousChar !== JSON_ESCAPE) {
            key.end = i
            keys.push(key)
            key = null
            status = JSON_PARSER_STATUS_FINDING_COLON
          }
          break
        case JSON_PARSER_STATUS_FINDING_COLON:
          if (currentChar === JSON_COLON) {
            status = JSON_PARSER_STATUS_FINDING_VALUE
          }
          break
        case JSON_PARSER_STATUS_FINDING_VALUE:
          if (currentStruct === JSON_STRUCT_ARRAY && currentChar === JSON_ARRAY_END) {
            currentStruct = structsPool.pop()

            if (currentStruct === JSON_STRUCT_ARRAY) {
              status = JSON_PARSER_STATUS_FINDING_VALUE
            } if (currentStruct === JSON_STRUCT_OBJECT) {
              status = JSON_PARSER_STATUS_FINDING_KEY
            } else {
              status = JSON_PARSER_STATUS_STARTING
            }
          } else if (currentChar === JSON_STRING) {
            status = JSON_PARSER_STATUS_READING_STRING_VALUE
          } else if (currentChar === JSON_OBJECT_START) {
            structsPool.push(currentStruct)
            currentStruct = JSON_STRUCT_OBJECT
            status = JSON_PARSER_STATUS_FINDING_KEY
          } else if (currentChar === JSON_ARRAY_START) {
            structsPool.push(currentStruct)
            currentStruct = JSON_STRUCT_ARRAY
            status = JSON_PARSER_STATUS_FINDING_VALUE
          } else if (!currentChar.match(/\s|,/)) {
            status = JSON_PARSER_STATUS_READING_VALUE
          }
          break
        case JSON_PARSER_STATUS_READING_STRING_VALUE:
          if (!value) {
            value = {
              start: i
            }
          }

          if (currentChar === JSON_STRING && previousChar !== JSON_ESCAPE) {
            value.end = i
            values.push(value)
            value = undefined
            if (currentStruct === JSON_STRUCT_OBJECT) {
              status = JSON_PARSER_STATUS_FINDING_KEY
            } else if (currentStruct === JSON_STRUCT_ARRAY) {
              status = JSON_PARSER_STATUS_FINDING_VALUE
            }
          }
          break
        case JSON_PARSER_STATUS_READING_VALUE:
          if (!value) {
            value = {
              start: i - 1
            }
          }
          if (JSON_VALUE_FINISHERS.includes(currentChar)) {
            value.end = i
            values.push(value)
            value = undefined
            if (currentChar === JSON_ARRAY_END || currentChar === JSON_OBJECT_END) {
              currentStruct = structsPool.pop()
            }
            if (currentStruct === JSON_STRUCT_OBJECT) {
              status = JSON_PARSER_STATUS_FINDING_KEY
            } else if (currentStruct === JSON_STRUCT_ARRAY) {
              status = JSON_PARSER_STATUS_FINDING_VALUE
            }
          }
          break
      }
    }

    return { keys, values }
  }
}

module.exports = JsonSensitiveAnalyzer
