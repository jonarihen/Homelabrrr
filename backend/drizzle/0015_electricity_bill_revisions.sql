ALTER TABLE "electricity_bills" ADD COLUMN "previous_id" integer;--> statement-breakpoint
ALTER TABLE "electricity_bills" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "electricity_bills" ADD COLUMN "void_reason" text;