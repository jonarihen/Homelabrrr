ALTER TABLE "backup_runs" ADD COLUMN "full_restore_verified_at" timestamp with time zone;
UPDATE "backup_runs" SET "status" = 'toc_checked' WHERE "status" = 'verified';