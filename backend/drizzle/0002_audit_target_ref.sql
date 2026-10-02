ALTER TABLE "audit_log" ADD COLUMN "target_ref" text;--> statement-breakpoint
CREATE INDEX "idx_audit_log_target_ref" ON "audit_log" USING btree ("target_ref");
