/** Discord-Berechtigungen mit deutschen Bezeichnungen (für Rollen- und Kanaleditor). */
export const PERMISSIONS: { key: string; bit: bigint; label: string; group: string }[] = [
  { key: 'Administrator', bit: 1n << 3n, label: 'Administrator', group: 'Allgemein' },
  { key: 'ViewChannel', bit: 1n << 10n, label: 'Kanäle ansehen', group: 'Allgemein' },
  { key: 'ManageChannels', bit: 1n << 4n, label: 'Kanäle verwalten', group: 'Allgemein' },
  { key: 'ManageRoles', bit: 1n << 28n, label: 'Rollen verwalten', group: 'Allgemein' },
  { key: 'ManageGuild', bit: 1n << 5n, label: 'Server verwalten', group: 'Allgemein' },
  { key: 'ViewAuditLog', bit: 1n << 7n, label: 'Audit-Log ansehen', group: 'Allgemein' },
  { key: 'ManageWebhooks', bit: 1n << 29n, label: 'Webhooks verwalten', group: 'Allgemein' },
  { key: 'ManageGuildExpressions', bit: 1n << 30n, label: 'Emojis & Sticker verwalten', group: 'Allgemein' },
  { key: 'CreateInstantInvite', bit: 1n << 0n, label: 'Einladung erstellen', group: 'Mitglieder' },
  { key: 'ChangeNickname', bit: 1n << 26n, label: 'Nickname ändern', group: 'Mitglieder' },
  { key: 'ManageNicknames', bit: 1n << 27n, label: 'Nicknames verwalten', group: 'Mitglieder' },
  { key: 'KickMembers', bit: 1n << 1n, label: 'Mitglieder kicken', group: 'Mitglieder' },
  { key: 'BanMembers', bit: 1n << 2n, label: 'Mitglieder bannen', group: 'Mitglieder' },
  { key: 'ModerateMembers', bit: 1n << 40n, label: 'Timeout vergeben', group: 'Mitglieder' },
  { key: 'SendMessages', bit: 1n << 11n, label: 'Nachrichten senden', group: 'Text' },
  { key: 'SendMessagesInThreads', bit: 1n << 38n, label: 'In Threads schreiben', group: 'Text' },
  { key: 'CreatePublicThreads', bit: 1n << 35n, label: 'Öffentliche Threads erstellen', group: 'Text' },
  { key: 'EmbedLinks', bit: 1n << 14n, label: 'Links einbetten', group: 'Text' },
  { key: 'AttachFiles', bit: 1n << 15n, label: 'Dateien anhängen', group: 'Text' },
  { key: 'AddReactions', bit: 1n << 6n, label: 'Reaktionen hinzufügen', group: 'Text' },
  { key: 'UseExternalEmojis', bit: 1n << 18n, label: 'Externe Emojis', group: 'Text' },
  { key: 'MentionEveryone', bit: 1n << 17n, label: '@everyone erwähnen', group: 'Text' },
  { key: 'ManageMessages', bit: 1n << 13n, label: 'Nachrichten verwalten', group: 'Text' },
  { key: 'ManageThreads', bit: 1n << 34n, label: 'Threads verwalten', group: 'Text' },
  { key: 'ReadMessageHistory', bit: 1n << 16n, label: 'Nachrichtenverlauf lesen', group: 'Text' },
  { key: 'UseApplicationCommands', bit: 1n << 31n, label: 'Slash-Commands nutzen', group: 'Text' },
  { key: 'Connect', bit: 1n << 20n, label: 'Verbinden', group: 'Sprache' },
  { key: 'Speak', bit: 1n << 21n, label: 'Sprechen', group: 'Sprache' },
  { key: 'Stream', bit: 1n << 9n, label: 'Video/Stream', group: 'Sprache' },
  { key: 'MuteMembers', bit: 1n << 22n, label: 'Mitglieder stummschalten', group: 'Sprache' },
  { key: 'DeafenMembers', bit: 1n << 23n, label: 'Mitglieder taub schalten', group: 'Sprache' },
  { key: 'MoveMembers', bit: 1n << 24n, label: 'Mitglieder verschieben', group: 'Sprache' },
  { key: 'PrioritySpeaker', bit: 1n << 8n, label: 'Very Important Speaker', group: 'Sprache' },
];

export function hasBit(bits: string, bit: bigint) {
  return (BigInt(bits) & bit) === bit;
}

export function toggleBit(bits: string, bit: bigint, on: boolean) {
  const b = BigInt(bits);
  return (on ? b | bit : b & ~bit).toString();
}

export const PERMISSION_LABELS: Record<string, string> = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));
