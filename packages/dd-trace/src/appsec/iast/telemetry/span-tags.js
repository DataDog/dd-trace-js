'use strict'

function addMetricsToSpan (rootSpan, metrics, tagPrefix) {
  if (!rootSpan?.addTags || !metrics) return

  let tagObject

  for (const data of metrics) {
    const metric = data?.metric
    if (metric) {
      const name = `${tagPrefix}.${taggedMetricName(data)}`
      const value = sum(data)
      tagObject ??= {}
      tagObject[name] = (tagObject[name] ?? 0) + value
    }
  }

  if (tagObject !== undefined) {
    rootSpan.addTags(tagObject)
  }
}

function sum (metricData) {
  const { points } = metricData
  return points ? points.reduce((total, [, value]) => total + value, 0) : 0
}

function taggedMetricName (data) {
  let metric = data.metric
  let processedTag = ''
  for (let i = 0; i < data.tags?.length; i++) {
    const tag = data.tags[i]
    if (!tag.startsWith('version')) {
      if (i !== 0) {
        processedTag += '_'
      }
      const colonIndex = tag.indexOf(':')
      processedTag += colonIndex === -1 ? tag : tag.slice(colonIndex + 1)
    }
  }
  if (processedTag !== '') {
    metric += `.${processedTag.replaceAll('.', '_')}`
  }
  return metric
}

module.exports = {
  addMetricsToSpan,
}
