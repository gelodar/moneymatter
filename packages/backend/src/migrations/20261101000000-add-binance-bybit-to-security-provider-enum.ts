/* eslint-disable @typescript-eslint/no-explicit-any */
import { QueryInterface } from 'sequelize';

// Define constants for enum names to prevent typos
const ENUM_SECURITY_PROVIDER = 'enum_security_provider';

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    // Add enum values without transaction as PostgreSQL doesn't allow enum changes in transactions
    await queryInterface.sequelize.query(
      `ALTER TYPE "${ENUM_SECURITY_PROVIDER}" ADD VALUE IF NOT EXISTS 'binance';`,
    );

    await queryInterface.sequelize.query(
      `ALTER TYPE "${ENUM_SECURITY_PROVIDER}" ADD VALUE IF NOT EXISTS 'bybit';`,
    );
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    // PostgreSQL doesn't support dropping enum values directly; recreate the
    // enum without 'binance'/'bybit' after removing rows that reference them.
    const t = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.sequelize.query(
        `DELETE FROM "InvestmentTransactions" WHERE "securityId" IN (
          SELECT id FROM "Securities" WHERE "providerName" IN ('binance', 'bybit')
        );`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(
        `DELETE FROM "Holdings" WHERE "securityId" IN (
          SELECT id FROM "Securities" WHERE "providerName" IN ('binance', 'bybit')
        );`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(
        `DELETE FROM "SecurityPricings" WHERE "securityId" IN (
          SELECT id FROM "Securities" WHERE "providerName" IN ('binance', 'bybit')
        );`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(
        `DELETE FROM "Securities" WHERE "providerName" IN ('binance', 'bybit');`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(
        `CREATE TYPE "${ENUM_SECURITY_PROVIDER}_new" AS ENUM ('polygon', 'other', 'alphavantage', 'fmp', 'yahoo', 'coingecko');`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "Securities" ALTER COLUMN "providerName" TYPE "${ENUM_SECURITY_PROVIDER}_new" USING "providerName"::text::"${ENUM_SECURITY_PROVIDER}_new";`,
        { transaction: t },
      );

      await queryInterface.sequelize.query(`DROP TYPE "${ENUM_SECURITY_PROVIDER}";`, { transaction: t });

      await queryInterface.sequelize.query(
        `ALTER TYPE "${ENUM_SECURITY_PROVIDER}_new" RENAME TO "${ENUM_SECURITY_PROVIDER}";`,
        { transaction: t },
      );

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },
};
