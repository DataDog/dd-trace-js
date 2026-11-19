module.exports = async function POST (req, res) {
  console.error(`pages api handler executed: ${req.body.id}`) // eslint-disable-line no-console
  res.status(200).json({
    cache: 'no-store',
    data: req.body,
  })
}
