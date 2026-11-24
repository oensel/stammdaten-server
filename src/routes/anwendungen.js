// GET /v1/anwendungen – öffentlich, für den App-Umschalter: aktive Apps mit Startadresse (docs/sso-entscheidung.md 3)
export default async function anwendungenRoutes(app) {
  app.get('/v1/anwendungen', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return (await app.pool.query(
      `select schluessel, name, url, icon from anwendungen where aktiv and url is not null order by name`)).rows;
  });
}
