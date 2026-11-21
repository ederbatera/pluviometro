-- Script SQL para criação manual ou verificação das tabelas no MariaDB (banco: pluviometro)
CREATE DATABASE IF NOT EXISTS `pluviometro`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `pluviometro`;

CREATE TABLE IF NOT EXISTS `StationConfig` (
  `id` VARCHAR(64) NOT NULL DEFAULT 'default',
  `name` VARCHAR(120) NOT NULL DEFAULT 'Estação Principal',
  `location` VARCHAR(160) NOT NULL DEFAULT 'Jardim / Ponto 01',
  `mmPerPulse` DOUBLE NOT NULL DEFAULT 0.25,
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  `ingestKeyHash` VARCHAR(255) NULL,
  `ingestKeyHint` VARCHAR(64) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AdminUser` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `displayName` VARCHAR(120) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'admin',
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `AdminUser_username_key` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AuthSession` (
  `id` VARCHAR(64) NOT NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `userId` INT NULL,
  `username` VARCHAR(64) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'admin',
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `AuthSession_tokenHash_key` (`tokenHash`),
  KEY `AuthSession_expiresAt_idx` (`expiresAt`),
  KEY `AuthSession_userId_idx` (`userId`),
  CONSTRAINT `AuthSession_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `AdminUser` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `RainPulse` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `stationId` VARCHAR(64) NOT NULL DEFAULT 'default',
  `eventUid` VARCHAR(128) NOT NULL,
  `mm` DOUBLE NOT NULL,
  `timestampUnix` INT NOT NULL,
  `eventAt` DATETIME(3) NOT NULL,
  `queuedAt` DATETIME(3) NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'raspberry',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `RainPulse_eventUid_key` (`eventUid`),
  KEY `RainPulse_eventAt_idx` (`eventAt`),
  KEY `RainPulse_stationId_eventAt_idx` (`stationId`, `eventAt`),
  KEY `RainPulse_timestampUnix_idx` (`timestampUnix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `HourlySummary` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `stationId` VARCHAR(64) NOT NULL DEFAULT 'default',
  `hourKey` VARCHAR(32) NOT NULL,
  `hourStart` DATETIME(3) NOT NULL,
  `totalMm` DOUBLE NOT NULL DEFAULT 0,
  `pulseCount` INT NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `HourlySummary_hourKey_key` (`hourKey`),
  KEY `HourlySummary_hourStart_idx` (`hourStart`),
  KEY `HourlySummary_stationId_hourStart_idx` (`stationId`, `hourStart`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `DailySummary` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `stationId` VARCHAR(64) NOT NULL DEFAULT 'default',
  `dayKey` VARCHAR(16) NOT NULL,
  `dayStart` DATETIME(3) NOT NULL,
  `totalMm` DOUBLE NOT NULL DEFAULT 0,
  `pulseCount` INT NOT NULL DEFAULT 0,
  `peakIntensityMm` DOUBLE NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `DailySummary_dayKey_key` (`dayKey`),
  KEY `DailySummary_dayStart_idx` (`dayStart`),
  KEY `DailySummary_stationId_dayStart_idx` (`stationId`, `dayStart`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
