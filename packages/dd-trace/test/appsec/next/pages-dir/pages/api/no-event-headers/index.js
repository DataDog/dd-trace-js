export default function handler (req, res) {
  const body = JSON.stringify({ ok: true })
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.status(200).send(body)
}
