import { EmbedBuilder, type ColorResolvable } from 'discord.js';

export const COLORS = {
  brand: 0x6366f1,
  violet: 0x8b5cf6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  info: 0x3b82f6,
  muted: 0x64748b,
} as const;

export function embed(color: ColorResolvable = COLORS.brand) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

export function success(text: string) {
  return embed(COLORS.success).setDescription(`✅ ${text}`);
}

export function failure(text: string) {
  return embed(COLORS.danger).setDescription(`❌ ${text}`);
}

export function info(text: string) {
  return embed(COLORS.info).setDescription(text);
}

export function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || COLORS.brand;
}

/** Kürzt Text auf eine maximale Länge (Discord-Limits). */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
