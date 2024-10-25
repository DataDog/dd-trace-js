'use strict'

function addMetricsToSpan (rootSpan, metrics, tagPrefix) {
  if (!rootSpan?.addTags || !metrics) return

  const flattenMap = new Map()
  metrics
    .filter(data => data?.metric)
    .forEach(data => {
      const name = taggedMetricName(data)
      let total = flattenMap.get(name)
      const value = flatten(data)
      if (!total) {
        total = value
      } else {
        total += value
      }
      flattenMap.set(name, total)
    })

  for (const [key, value] of flattenMap) {
    const tagName = `${tagPrefix}.${key}`
    rootSpan.addTags({
      [tagName]: value
    })
  }
}

function flatten (metricData) {
  const { points } = metricData
  return points ? points.map(point => point[1]).reduce((total, value) => total + value, 0) : 0
}

function taggedMetricName (data) {
  const metric = data.metric
  const tags = filterTags(data.tags)
  return !tags?.length
    ? metric
    : `${metric}.${processTagValue(tags)}`
}

function filterTags (tags) {
  return tags?.filter(tag => !tag.startsWith('version'))
}

function processTagValue (tags) {
  return tags.map(tag => tag.includes(':') ? tag.split(':')[1] : tag)
    .join('_').replace(/\./g, '_')
}

module.exports = {
  addMetricsToSpan,
  filterTags
}
