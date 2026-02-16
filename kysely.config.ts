import { PostgresDialect } from "kysely";
import { defineConfig } from "kysely-ctl";
import pg from "pg";

export default defineConfig({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    }),
  }),
  migrations: {
    migrationFolder: "src/store/kysely/migrations",
  },
});
