ALTER TABLE "electricity_contracts" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "electricity_contracts" ADD COLUMN "superseded_by_id" integer;