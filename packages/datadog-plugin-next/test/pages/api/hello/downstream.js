import http from 'node:http'

export default (req, res) => {
  http.get(process.env.DOWNSTREAM_URL, downstream => {
    downstream.resume()
    downstream.on('end', () => {
      res.status(200).json({ downstream: downstream.statusCode })
    })
  }).on('error', error => {
    res.status(500).json({ error: error.message })
  })
}
