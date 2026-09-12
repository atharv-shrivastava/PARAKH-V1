import "dotenv/config";

import { defineConfig } from "prisma/config";

// Prisma config is loaded during `npm install` via postinstall.
// CI and local code generation do not need a live database connection.
const databaseUrl =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  "postgresql://127.0.0.1:5432/parakh";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    url: databaseUrl,
  },
});
