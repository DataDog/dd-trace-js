export default function handler (req, res) {
  const body = req.query.mode === 'scalar' ? true : { value: 'café' }
  const mode = req.query.mode
  res.statusCode = 201
  if (mode === 'json') return res.json(body)
  if (mode === 'send') return res.send(body)
  if (mode === 'text') return res.send('text response')
  if (mode === 'empty') return res.status(204).end()

  return res.json(body)
}
