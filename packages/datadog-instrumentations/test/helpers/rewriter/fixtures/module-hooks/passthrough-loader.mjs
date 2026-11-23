// A third-party `--loader`, such as tsx, that passes every module through.
export async function load (url, context, nextLoad) {
  return nextLoad(url, context)
}
