import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level,
  base: undefined,
  redact: ['token', 'accessToken', 'refreshToken', '*.token', '*.accessToken', '*.refreshToken'],
  transport: pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
});

export function childLogger(name: string) {
  return logger.child({ mod: name });
}
