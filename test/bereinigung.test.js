import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neueApp } from './helper.js';

// SYS-INT-007 (FR-78, NFR-6): Personen und ihre Daten bleiben; bereinigt werden nur Nebendaten.
let t; let verein;
beforeAll(async () => {
  t = await neueApp();
  verein = (await t.pool.query(`select id from vereine where name = 'JC Demo'`)).rows[0].id;
});
afterAll(() => t.schliessen());

const q = (sql, p) => t.pool.query(sql, p).then((r) => r.rows);

describe('datenschutz_bereinigen()', () => {
  it('lässt ausgetretene und gelöschte Personen samt Graduierung und Lizenz unverändert', async () => {
    const [alt] = await q(
      `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname, email, status, austritt)
       values ($1, 9001, 'Max', 'Alt', 'max@example.org', 'ausgetreten', current_date - interval '20 years') returning id`, [verein]);
    const [weg] = await q(
      `insert into mitglieder (verein_id, mitgliedsnr, vorname, nachname, geloescht_am)
       values ($1, 9002, 'Erika', 'Weg', now() - interval '10 years') returning id`, [verein]);
    for (const id of [alt.id, weg.id]) {
      await q(`insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, urkunden_nr) values ($1,$2,'dan',1,'2001-01-01','U-1')`, [verein, id]);
      await q(`insert into lizenzen (verein_id, mitglied_id, art, nummer) values ($1,$2,'trainerlizenz',$3)`, [verein, id, `T-${id}`]);
    }
    const vorher = await q(`select m.*, g.urkunden_nr, l.nummer from mitglieder m join graduierungen g on g.mitglied_id = m.id
                            join lizenzen l on l.mitglied_id = m.id where m.id = any($1) order by m.id`, [[alt.id, weg.id]]);

    await q('select * from datenschutz_bereinigen()');

    const nachher = await q(`select m.*, g.urkunden_nr, l.nummer from mitglieder m join graduierungen g on g.mitglied_id = m.id
                             join lizenzen l on l.mitglied_id = m.id where m.id = any($1) order by m.id`, [[alt.id, weg.id]]);
    expect(nachher).toEqual(vorher);
    expect(nachher.every((m) => m.anonymisiert_am === null && m.nachname !== 'Anonymisiert')).toBe(true);
  });

  it('lässt gelöschte Benutzer bestehen und räumt nur ihre Tokens', async () => {
    const [b] = await q(`select id, benutzername, email from benutzer where geloescht_am is null order by benutzername limit 1`);
    const [app] = await q(`select id from anwendungen limit 1`);
    await q(`insert into refresh_tokens (benutzer_id, anwendung_id, token_hash, laeuft_ab_am)
             values ($1, $2, repeat('a', 64), now() + interval '30 days')`, [b.id, app.id]).catch(async (e) => {
      throw new Error(`refresh_tokens-Spalten prüfen: ${e.message}`);
    });
    await q(`update benutzer set geloescht_am = now() - interval '1 year' where id = $1`, [b.id]);

    const bericht = await q('select * from datenschutz_bereinigen()');

    expect(bericht.map((r) => r.bereich)).not.toContain('mitglieder');
    expect(Number(bericht.find((r) => r.bereich === 'papierkorb_tokens').anzahl)).toBeGreaterThanOrEqual(1);
    const [danach] = await q(`select benutzername, email, anonymisiert_am from benutzer where id = $1`, [b.id]);
    expect(danach).toEqual({ benutzername: b.benutzername, email: b.email, anonymisiert_am: null });
    expect(await q(`select 1 from refresh_tokens where benutzer_id = $1`, [b.id])).toHaveLength(0);
  });

  it('löscht Audit-Einträge nur jenseits der Frist', async () => {
    await q(`insert into audit_log (zeitpunkt, tabelle, aktion) values (now() - interval '3 years', 'mitglieder', 'aendern'),
             (now() - interval '1 day', 'mitglieder', 'aendern')`);
    await q('select * from datenschutz_bereinigen()');
    const rest = await q(`select zeitpunkt from audit_log where zeitpunkt < now() - interval '2 years'`);
    expect(rest).toHaveLength(0);
    expect((await q(`select 1 from audit_log where zeitpunkt > now() - interval '2 days'`)).length).toBeGreaterThan(0);
  });
});
