import 'dd-trace/init.js';
import Hapi from '@hapi/hapi';
import getPort from 'get-port';
import http from 'http'; // Import the http module

let server;
const port = await getPort();

console.log('PORT is ', port);

const handler = (request, h, body) => h.response ? h.response(body) : h(body);

const init = async () => {
  server = Hapi.server({
    address: '127.0.0.1',
    port,
  });

  await server.start();

  server.route({
    method: 'GET',
    path: '/user/{id}',
    handler: (request, h) => {
      return handler(request, h);
    },
  });

  server.route({
    method: 'POST',
    path: '/user/{id}',
    handler: (request, h) => {
      return handler(request, h);
    },
  });
};

try {
  await init();

  // Make the GET request using http
  const options = {
    hostname: 'localhost',
    port,
    path: '/user/3213',
    method: 'GET',
  };

  const data = await new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });

  console.log('Response:', data);

  server.stop();
  console.log('Server stopped gracefully.');
} catch (error) {
  console.error('Error occurred:', error);
}