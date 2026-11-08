import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
