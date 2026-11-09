-- CreateEnum
CREATE TYPE "GiveawayStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "prize" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "color" TEXT NOT NULL DEFAULT '#8b5cf6',
    "winnerCount" INTEGER NOT NULL DEFAULT 1,
    "hostId" TEXT NOT NULL,
    "status" "GiveawayStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "requiredRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minMemberDays" INTEGER NOT NULL DEFAULT 0,
    "minAccountDays" INTEGER NOT NULL DEFAULT 0,
    "requireVerified" BOOLEAN NOT NULL DEFAULT false,
    "maxEntries" INTEGER,
    "reminderMinutes" INTEGER NOT NULL DEFAULT 60,
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "seed" TEXT NOT NULL,
    "seedHash" TEXT NOT NULL,
    "winners" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "drawOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rerolls" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "countDirty" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayEntry" (
    "giveawayId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("giveawayId","userId")
);

-- CreateIndex
CREATE INDEX "Giveaway_guildId_status_idx" ON "Giveaway"("guildId", "status");

-- CreateIndex
CREATE INDEX "Giveaway_status_endsAt_idx" ON "Giveaway"("status", "endsAt");

-- CreateIndex
CREATE INDEX "Giveaway_status_startsAt_idx" ON "Giveaway"("status", "startsAt");

-- CreateIndex
CREATE INDEX "GiveawayEntry_giveawayId_createdAt_idx" ON "GiveawayEntry"("giveawayId", "createdAt");

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
