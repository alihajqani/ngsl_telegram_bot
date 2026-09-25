CREATE TYPE "public"."clip_accent" AS ENUM('us', 'uk', 'any');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "clip_accent" "clip_accent" DEFAULT 'us' NOT NULL;