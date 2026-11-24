import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { errorHandler, notFound } from './errors.js';
import { ladeSchluessel } from './keys.js';
import authRoutes from './routes/auth.js';
import benutzerRoutes from './routes/benutzer.js';
import ichRoutes from './routes/ich.js';
import geraeteRoutes from './routes/geraete.js';
import einmalRoutes from './routes/einmal.js';
import mitgliederRoutes from './routes/mitglieder.js';
import abgleichRoutes from './routes/abgleich.js';
import graduierungenRoutes from './routes/graduierungen.js';
import rechteRoutes from './routes/rechte.js';
import anwendungenRoutes from './routes/anwendungen.js';
import organisationRouten from './module/organisation/routen.js';
import personenRouten from './module/personen/routen.js';
import rechteV2Routen from './module/rechte/routen.js';
import zugangV2Routen from './module/zugang/routen.js';
import { registriereV2 } from './pipeline/index.js';
import { registriereBackchannel } from './backchannel.js';
import { createMailer } from './mailer.js';

/** Baut die App. pool/keys können für Tests übergeben werden. */
export async function buildApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const app = Fastify({ logger: cfg.logger, trustProxy: true, bodyLimit: 64 * 1024 });
  app.decorate('cfg', cfg);
  app.decorate('pool', overrides.pool || createPool(cfg.databaseUrl));
  app.decorate('keys', await ladeSchluessel(app.pool, cfg.schluesselKek));
  app.decorate('mailer', overrides.mailer || createMailer(cfg, app.log));
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => errorHandler(notFound(), req, reply));

  // Apps laufen als https://localhost (Android/Capacitor), capacitor://localhost (iOS) – Bearer-Tokens, keine Cookies
  await app.register(cors, { origin: cfg.corsOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Verein', 'If-Match'], exposedHeaders: ['ETag'], credentials: true, maxAge: 600 });
  app.addHook('onSend', async (req, reply) => { if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store'); });

  app.get('/.well-known/jwks.json', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return app.keys.jwks;
  });
  app.get('/.well-known/openid-configuration', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return {
      issuer: cfg.issuer, jwks_uri: `${cfg.issuer}/.well-known/jwks.json`, token_endpoint: `${cfg.issuer}/oauth/token`,
      id_token_signing_alg_values_supported: ['EdDSA'], grant_types_supported: ['refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    };
  });
  app.get('/health', async () => ({ ok: true }));

  registriereBackchannel(app);
  await app.register(authRoutes);
  await app.register(anwendungenRoutes);
  await app.register(ichRoutes);
  await app.register(benutzerRoutes);
  await app.register(geraeteRoutes);
  await app.register(einmalRoutes);
  await app.register(mitgliederRoutes);
  await app.register(abgleichRoutes);
  await app.register(graduierungenRoutes);
  await app.register(rechteRoutes);
  await registriereV2(app, (v2) => { for (const definiere of [organisationRouten, personenRouten, rechteV2Routen, zugangV2Routen, ...(overrides.v2Routen || [])]) definiere(v2); });

  app.addHook('onClose', async () => { if (!overrides.pool) await app.pool.end(); });
  return app;
}
