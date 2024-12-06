module.exports = function () {
  try {
    return typeof jest !== 'undefined'
  } catch (e) {
    return false
  }
}
