ALTER TABLE "paypal_intents" ADD COLUMN "capture_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_reconciliation" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_reconciliation" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_reconciliation" ADD COLUMN "failed_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_subscriptions" ADD COLUMN "reconcile_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_subscriptions" ADD COLUMN "reconcile_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_subscriptions" ADD COLUMN "reconcile_error_code" text;--> statement-breakpoint
ALTER TABLE "paypal_transactions" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "paypal_transactions" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_transactions" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_transactions" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "paypal_webhook_inbox" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_webhook_inbox" ADD COLUMN "resolved_by" integer;--> statement-breakpoint
ALTER TABLE "paypal_webhook_inbox" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "paypal_webhook_inbox" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "paypal_webhook_inbox" ADD CONSTRAINT "paypal_webhook_inbox_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;