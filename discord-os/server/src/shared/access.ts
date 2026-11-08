/** Dashboard-Zugriffsstufen (aufsteigend). */
export const ACCESS = { NONE: 0, VIEWER: 1, MODERATOR: 2, ADMIN: 3, OWNER: 4 } as const;
export type AccessName = keyof typeof ACCESS;
export type AccessValue = (typeof ACCESS)[AccessName];

export function accessName(v: number): AccessName {
  return (Object.keys(ACCESS) as AccessName[]).find((k) => ACCESS[k] === v) ?? 'NONE';
}

/** Discord-Berechtigungsbits, die das Dashboard auswertet. */
export const PERM = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  MODERATE_MEMBERS: 1n << 40n,
  MANAGE_MESSAGES: 1n << 13n,
} as const;

export function hasPerm(bits: string | bigint, perm: bigint): boolean {
  const b = typeof bits === 'bigint' ? bits : BigInt(bits);
  return (b & PERM.ADMINISTRATOR) === PERM.ADMINISTRATOR || (b & perm) === perm;
}
