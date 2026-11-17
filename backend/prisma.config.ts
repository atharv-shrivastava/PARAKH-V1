import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    url: process.env.DIRECT_URL || "postgresql://postgres:unset@127.0.0.1:5432/parakh?schema=public",
  },
});