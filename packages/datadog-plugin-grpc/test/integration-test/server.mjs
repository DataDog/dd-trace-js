import 'dd-trace/init.js';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import getPort from 'get-port';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let server;
const port = await getPort();

function buildClient(service, callback) {
  service = Object.assign(
    {
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {},
    },
    service
  );

  const protoPath = resolve(__dirname, '../test.proto');
  const definition = loader.loadSync(protoPath);
  const TestService = grpc.loadPackageDefinition(definition).test.TestService;

  server = new grpc.Server();

  return new Promise((resolve, reject) => {
    if (server.bindAsync) {
      server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) {
          console.error('Error binding server:', err);
          return reject(err);
        }

        console.log(`Server bound to 0.0.0.0:${port}`);
        server.addService(TestService.service, service);
        server.start();

        console.log('Server started');
        resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()));
      });
    } else {
      server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure());
      server.addService(TestService.service, service);
      server.start();

      console.log(`Server bound to 0.0.0.0:${port}`);
      console.log('Server started');
      resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()));
    }
  });
}

(async () => {
  try {
    const client = await buildClient({
      getUnary: (_, callback) => {
        console.log('Unary request received');
        callback();
      },
    });

    await client.getUnary({ first: 'foobar' }, () => {});

    await client.close();

    if (server) {
      server.forceShutdown((err) => {
        if (err) console.error('Error during server shutdown:', err);
        else console.log('Server shutdown successfully');
      });
    }
  } catch (err) {
    console.error('Error:', err);
  }
})();
