/**
 * Einfache Platzhalter-Ersetzung für Nachrichten: {user}, {username}, {server}, {memberCount}, {level} …
 * Unbekannte Platzhalter bleiben unverändert stehen.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_.]*)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? match : String(v);
  });
}

export const TEMPLATE_VARIABLES = [
  { key: '{user}', description: 'Erwähnung des Mitglieds' },
  { key: '{username}', description: 'Benutzername' },
  { key: '{userId}', description: 'User-ID' },
  { key: '{server}', description: 'Servername' },
  { key: '{memberCount}', description: 'Aktuelle Mitgliederzahl' },
  { key: '{level}', description: 'Neues Level (Level-Up)' },
  { key: '{channel}', description: 'Erwähnung des Kanals' },
  { key: '{date}', description: 'Aktuelles Datum' },
] as const;
