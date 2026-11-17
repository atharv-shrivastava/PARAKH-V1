import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Prefer the runtime/pooler URL when provided. Keep DIRECT_URL as a local/CLI fallback.
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL || "postgresql://postgres:unset@127.0.0.1:5432/parakh?schema=public";

if (!connectionString) {
  throw new Error("DATABASE_URL or DIRECT_URL must be configured for PARAKH backend database access.");
}

const adapter = new PrismaPg({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 60000,
});

const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    maxWait: 10000,
    timeout: 30000,
  },
});

export default prisma;
