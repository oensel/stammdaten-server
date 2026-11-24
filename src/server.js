import { buildApp } from './app.js';

const app = await buildApp({ logger: true });
await app.listen({ port: app.cfg.port, host: app.cfg.host });
const zu = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', zu);
process.on('SIGTERM', zu);
