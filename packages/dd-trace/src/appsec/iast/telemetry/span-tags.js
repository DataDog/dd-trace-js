'use strict'

function addMetricsToSpan (rootSpan, metrics, tagPrefix) {
  if (!rootSpan?.addTags || !metrics) return

  const flattenMap = new Map()
  for (const data of metrics) {
    const metric = data?.metric
    if (metric) {
      const name = taggedMetricName(data)
      let total = flattenMap.get(name) ?? 0
      const value = sum(data)
      total += value
      flattenMap.set(name, total)
    }
  }

  for (const [key, value] of flattenMap) {
    rootSpan.setTag(`${tagPrefix}.${key}`, value)
  }
}

function sum (metricData) {
  const { points } = metricData
  return points ? points.reduce((total, [, value]) => total + value, 0) : 0
}

function taggedMetricName (data) {
  const metric = data.metric
  const tags = filterTags(data.tags)
  return tags?.length
    ? `${metric}.${processTagValue(tags)}`
    : metric
}

function filterTags (tags) {
  return tags?.filter(tag => !tag.startsWith('version'))
}

function processTagValue (tags) {
  return tags.map(tag => tag.includes(':') ? tag.split(':')[1] : tag)
    .join('_').replaceAll('.', '_')
}

module.exports = {
  addMetricsToSpan,
  filterTags
}
