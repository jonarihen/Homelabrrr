ALTER TABLE "hardware_power_operations" ADD COLUMN "actor_user_id" integer;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "config_version" integer;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "schedule_version" integer;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "price_policy_version" integer;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "price_dkk_per_kwh" text;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "price_start_utc" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "price_end_utc" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "price_source" jsonb;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "thresholds" jsonb;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "error_category" text;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "last_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "failure_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "pending_target" text;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "pending_operation_id" integer;--> statement-breakpoint
ALTER TABLE "hardware_power_policies" ADD COLUMN "drift_hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hardware_power_operations" ADD CONSTRAINT "hardware_power_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hardware_power_operations_claim_idx" ON "hardware_power_operations" USING btree ("claim_token");