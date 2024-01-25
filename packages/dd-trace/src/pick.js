function pick (object, properties) {
  const result = {}

  for (const property of properties) {
    if (object.hasOwnProperty(property)) {
      result[property] = object[property]
    }
  }

  return result
}

module.exports = pick
