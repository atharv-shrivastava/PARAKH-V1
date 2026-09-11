ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "manufacturerName" TEXT;
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "violationType" TEXT;
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "violationSeverity" TEXT;
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "isVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "Inspection" ADD COLUMN IF NOT EXISTS "batchNumber" TEXT;
CREATE INDEX IF NOT EXISTS "Shop_city_idx" ON "Shop"("city");
CREATE INDEX IF NOT EXISTS "Shop_state_idx" ON "Shop"("state");
CREATE INDEX IF NOT EXISTS "Product_manufacturerName_idx" ON "Product"("manufacturerName");
CREATE INDEX IF NOT EXISTS "Inspection_batchNumber_idx" ON "Inspection"("batchNumber");
CREATE INDEX IF NOT EXISTS "Inspection_status_idx" ON "Inspection"("status");
CREATE INDEX IF NOT EXISTS "Inspection_isVerified_idx" ON "Inspection"("isVerified");
CREATE INDEX IF NOT EXISTS "Inspection_violationSeverity_idx" ON "Inspection"("violationSeverity");
CREATE INDEX IF NOT EXISTS "Inspection_violationType_idx" ON "Inspection"("violationType");
CREATE TABLE IF NOT EXISTS "BatchAlert" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "batchNumber" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'HIGH',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT NOT NULL,
  "verifiedById" TEXT,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "BatchAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BatchAlert_productId_batchNumber_key" ON "BatchAlert"("productId", "batchNumber");
CREATE INDEX IF NOT EXISTS "BatchAlert_batchNumber_idx" ON "BatchAlert"("batchNumber");
CREATE INDEX IF NOT EXISTS "BatchAlert_status_idx" ON "BatchAlert"("status");
CREATE INDEX IF NOT EXISTS "BatchAlert_severity_idx" ON "BatchAlert"("severity");
CREATE INDEX IF NOT EXISTS "BatchAlert_createdAt_idx" ON "BatchAlert"("createdAt");
CREATE TABLE IF NOT EXISTS "BatchIncidentReport" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "batchNumber" TEXT NOT NULL,
  "inspectionId" TEXT,
  "reportedById" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'HIGH',
  "status" TEXT NOT NULL DEFAULT 'REPORTED',
  "evidenceUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "batchAlertId" TEXT,
  CONSTRAINT "BatchIncidentReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BatchIncidentReport_productId_idx" ON "BatchIncidentReport"("productId");
CREATE INDEX IF NOT EXISTS "BatchIncidentReport_batchNumber_idx" ON "BatchIncidentReport"("batchNumber");
CREATE INDEX IF NOT EXISTS "BatchIncidentReport_status_idx" ON "BatchIncidentReport"("status");
CREATE INDEX IF NOT EXISTS "BatchIncidentReport_severity_idx" ON "BatchIncidentReport"("severity");
CREATE INDEX IF NOT EXISTS "BatchIncidentReport_reportedById_idx" ON "BatchIncidentReport"("reportedById");
DO $$ BEGIN ALTER TABLE "BatchAlert" ADD CONSTRAINT "BatchAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchAlert" ADD CONSTRAINT "BatchAlert_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchAlert" ADD CONSTRAINT "BatchAlert_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchIncidentReport" ADD CONSTRAINT "BatchIncidentReport_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchIncidentReport" ADD CONSTRAINT "BatchIncidentReport_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchIncidentReport" ADD CONSTRAINT "BatchIncidentReport_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BatchIncidentReport" ADD CONSTRAINT "BatchIncidentReport_batchAlertId_fkey" FOREIGN KEY ("batchAlertId") REFERENCES "BatchAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
