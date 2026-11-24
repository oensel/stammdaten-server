// ctx der Dienste (AD-2): { benutzer, kontext, rechte, anwendung, jetzt }
const KEINE_RECHTE = { rolle: null, rechte: [], scopes: [], stellvertreter: false, super_admin: false, verbandsrollen: [] };

export function baueCtx({ benutzer, kontext = null, rechte, anwendung, jetzt }) {
  return Object.freeze({ benutzer, kontext, rechte: Object.freeze({ ...KEINE_RECHTE, ...rechte }), anwendung, jetzt });
}

/** ctx für Jobs, Importe und Migrationen; einmal je Lauf erzeugen. `jetzt` ist im Test frei setzbar. */
export function systemCtx(name, { jetzt = new Date() } = {}) {
  if (!name) throw new Error('systemCtx braucht einen Namen');
  return baueCtx({ benutzer: null, anwendung: `system:${name}`, jetzt });
}
