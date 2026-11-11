export function tracked (name, callback) {
  return function () {
    // This is native callback evidence, independent of Datadog's emitted spans.
    // eslint-disable-next-line no-console
    console.log('__DD_EXCLUSION_EXECUTION__ ' + JSON.stringify(name))
    return callback.apply(this, arguments)
  }
}
