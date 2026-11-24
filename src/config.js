// Konfiguration aus Umgebung bzw. .env (Node ≥ 20.12: process.loadEnvFile). Entwicklungs-Standardwerte nur außerhalb von production.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const prod = process.env.NODE_ENV === 'production';
const env = (name, dev) => {
  const v = process.env[name];
  if (v) return v;
  if (prod || dev === undefined) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return dev;
};

export function loadConfig(overrides = {}) {
  return {
    port: Number(env('PORT', '4000')),
    host: env('HOST', '127.0.0.1'),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5440/stammdaten'),
    issuer: env('ISSUER', 'http://127.0.0.1:4000'),
    // 32 Byte hex: verschlüsselt die privaten Signaturschlüssel in der Datenbank
    schluesselKek: env('SCHLUESSEL_KEK', '0'.repeat(63) + '1'),
    corsOrigins: env('CORS_ORIGINS', 'https://localhost,capacitor://localhost,http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    accessTtlSek: Number(env('ACCESS_TTL_SEK', '600')),
    refreshTage: Number(env('REFRESH_TAGE', '30')),
    geraetTokenTage: Number(env('GERAET_TOKEN_TAGE', '90')),
    maxFehlversuche: Number(env('MAX_FEHLVERSUCHE', '5')),
    sperreMinuten: Number(env('SPERRE_MINUTEN', '15')),
    wiederverwendungSek: Number(env('WIEDERVERWENDUNG_SEK', '20')),
    demoClientSecret: env('DEMO_CLIENT_SECRET', 'demo-client-secret-nur-entwicklung'),
    demoPasswort: env('DEMO_PASSWORT', 'Demo-Passwort-1'),
    publicBaseUrl: env('PUBLIC_BASE_URL', 'http://127.0.0.1:4000').replace(/\/+$/, ''),
    smtp: { host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER || '', password: process.env.SMTP_PASSWORD || '', from: process.env.SMTP_FROM || '"Stammdaten" <no-reply@stammdaten.local>' },
    resetStunden: Number(env('RESET_STUNDEN', '1')),
    einladungTage: Number(env('EINLADUNG_TAGE', '7')),
    // Pflicht für Super-Admins; in production nicht abschaltbar (Story 2.9, NFR-16)
    zweiFaktorPflicht: prod || env('ZWEI_FAKTOR_PFLICHT', 'false') === 'true',
    cookieSecure: env('COOKIE_SECURE', 'false') !== 'false',
    cookieName: 'sd_refresh',
    // Back-Channel-Logout: Wartezeit vor jedem der 3 Versuche (ms)
    backchannelWartenMs: (process.env.BACKCHANNEL_WARTEN_MS || '0,1000,3000').split(',').map(Number),
    workerIntervallSek: Number(process.env.WORKER_INTERVALL_SEK || 30),
    // Uhr der Pipeline (ctx.jetzt), im Test ersetzbar
    uhr: () => new Date(),
    logger: process.env.LOG === '1',
    ...overrides,
  };
}
