process.env.DD_APPSEC_ENABLED = '1'
process.env.DD_APPSEC_RASP_ENABLED = '1'

const tracer = require('.').init()

//const { statSync } = require('fs')

const fastify = require('fastify')()

fastify.get('/rasp/lfi', async (request, reply) => {
	const { statSync } = require('fs')
	let result
	try {
	  result = JSON.stringify(statSync(request.query.file))
	} catch (e) {
		result = e.toString()

		if (e.name === 'DatadogRaspAbortError') {
	    	throw e
		}
	}
	return result
})


fastify.listen({ port: 1337 })
