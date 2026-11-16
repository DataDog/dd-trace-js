import http from 'http'

function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
}

function wrapInNonNativeError (error) {
  const wrapped = Object.create(Error.prototype)
  wrapped.name = 'WrappedError'
  wrapped.message = error.message
  wrapped.cause = error
  return wrapped
}

export default async function handler (req, res) {
  const { host = `127.0.0.1:${req.query.port}`, rethrow, wrap } = req.query

  try {
    res.status(200).json({ status: await get(`http://${host}/`) })
  } catch (error) {
    if (rethrow !== undefined) throw error
    if (wrap !== undefined) throw wrapInNonNativeError(error)

    res.status(200).json({ error: error.name })
  }
}
