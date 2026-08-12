CREATE TYPE "public"."buddy_status" AS ENUM('pending', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."dictionary" AS ENUM('cambridge', 'oxford');--> statement-breakpoint
CREATE TYPE "public"."example_source" AS ENUM('corpus', 'llm');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('fa', 'en');--> statement-breakpoint
CREATE TYPE "public"."phrase_kind" AS ENUM('collocation', 'idiom');--> statement-breakpoint
CREATE TYPE "public"."point_reason" AS ENUM('new_word', 'review_correct', 'writing_submitted', 'clip_watched', 'daily_goal', 'streak_milestone', 'quest_bonus');--> statement-breakpoint
CREATE TYPE "public"."review_result" AS ENUM('correct', 'wrong', 'known');--> statement-breakpoint
CREATE TYPE "public"."sub_status" AS ENUM('pending', 'manual', 'none');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('live', 'dead');--> statement-breakpoint
CREATE TYPE "public"."vote_kind" AS ENUM('like', 'dislike');--> statement-breakpoint
CREATE TABLE "activity_hour" (
	"user_id" integer NOT NULL,
	"hour" smallint NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "activity_hour_user_id_hour_pk" PRIMARY KEY("user_id","hour"),
	CONSTRAINT "ck_activity_hour_range" CHECK ("activity_hour"."hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE "app_state" (
	"key" varchar(96) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" varchar(64),
	"first_name" varchar(128),
	"locale" "locale" DEFAULT 'fa' NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_id" integer NOT NULL,
	"body" text NOT NULL,
	"sent_ok" integer DEFAULT 0 NOT NULL,
	"sent_failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buddy_pair" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_a" integer NOT NULL,
	"user_b" integer NOT NULL,
	"joint_streak" integer DEFAULT 0 NOT NULL,
	"last_both_studied_day" date,
	"status" "buddy_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_buddy_distinct" CHECK ("buddy_pair"."user_a" <> "buddy_pair"."user_b")
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" serial PRIMARY KEY NOT NULL,
	"yt_channel_id" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"tier" smallint DEFAULT 1 NOT NULL,
	"accent" varchar(32),
	"enabled" boolean DEFAULT true NOT NULL,
	"last_enumerated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip" (
	"id" serial PRIMARY KEY NOT NULL,
	"segment_id" bigint NOT NULL,
	"word_id" integer NOT NULL,
	"telegram_file_id" text,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"rendered_at" timestamp with time zone,
	"likes" integer DEFAULT 0 NOT NULL,
	"dislikes" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_vote" (
	"user_id" integer NOT NULL,
	"clip_id" integer NOT NULL,
	"vote" "vote_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clip_vote_user_id_clip_id_pk" PRIMARY KEY("user_id","clip_id")
);
--> statement-breakpoint
CREATE TABLE "daily_motivation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"for_day" date NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue" varchar(64) NOT NULL,
	"job_name" varchar(128) NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "league" (
	"id" serial PRIMARY KEY NOT NULL,
	"tier" smallint NOT NULL,
	"week_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_membership" (
	"league_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "league_membership_league_id_user_id_pk" PRIMARY KEY("league_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "points_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" "point_reason" NOT NULL,
	"ref_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"word_id" integer NOT NULL,
	"result" "review_result" NOT NULL,
	"box_before" smallint NOT NULL,
	"box_after" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"word_count" smallint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ck_segment_span" CHECK ("segment"."end_ms" > "segment"."start_ms")
);
--> statement-breakpoint
CREATE TABLE "user_clip_seen" (
	"user_id" integer NOT NULL,
	"clip_id" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_clip_seen_user_id_clip_id_pk" PRIMARY KEY("user_id","clip_id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"daily_new_target" smallint DEFAULT 5 NOT NULL,
	"daily_review_target" smallint DEFAULT 10 NOT NULL,
	"preferred_dictionary" "dictionary" DEFAULT 'cambridge' NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"motivation_enabled" boolean DEFAULT false NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"wall_of_shame_optin" boolean DEFAULT false NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Tehran' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_streak" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"longest" integer DEFAULT 0 NOT NULL,
	"last_study_day" date,
	"freezes_available" smallint DEFAULT 0 NOT NULL,
	"multiplier" real DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_word" (
	"user_id" integer NOT NULL,
	"word_id" integer NOT NULL,
	"box" smallint DEFAULT 1 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"next_review_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_word_user_id_word_id_pk" PRIMARY KEY("user_id","word_id"),
	CONSTRAINT "ck_user_word_box_range" CHECK ("user_word"."box" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "video" (
	"id" serial PRIMARY KEY NOT NULL,
	"yt_video_id" varchar(16) NOT NULL,
	"channel_id" integer NOT NULL,
	"title" text,
	"duration_s" integer,
	"sub_status" "sub_status" DEFAULT 'pending' NOT NULL,
	"status" "video_status" DEFAULT 'live' NOT NULL,
	"health_checked_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word" (
	"id" serial PRIMARY KEY NOT NULL,
	"lemma" varchar(64) NOT NULL,
	"sfi_rank" integer NOT NULL,
	"sfi" real,
	"adj_freq_per_million" integer,
	"definition" text,
	"bucket" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_word_bucket_range" CHECK ("word"."bucket" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "word_collocation" (
	"id" serial PRIMARY KEY NOT NULL,
	"word_id" integer NOT NULL,
	"phrase" varchar(160) NOT NULL,
	"meaning" text,
	"kind" "phrase_kind" DEFAULT 'collocation' NOT NULL,
	"ord" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_example" (
	"id" serial PRIMARY KEY NOT NULL,
	"word_id" integer NOT NULL,
	"text" text NOT NULL,
	"source" "example_source" NOT NULL,
	"segment_id" bigint,
	"quality_score" real DEFAULT 0 NOT NULL,
	"ord" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_occurrence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"word_id" integer NOT NULL,
	"segment_id" bigint NOT NULL,
	"quality_score" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "writing_session" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"target_lemmas" text[] NOT NULL,
	"submitted_text" text,
	"corrected_text" text,
	"ai_sample_text" text,
	"score" smallint,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_writing_score" CHECK ("writing_session"."score" is null or "writing_session"."score" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "writing_summary" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"grammar_patterns" text[] DEFAULT '{}' NOT NULL,
	"missed_vocabulary" text[] DEFAULT '{}' NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"last_session_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_hour" ADD CONSTRAINT "activity_hour_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_admin_id_app_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buddy_pair" ADD CONSTRAINT "buddy_pair_user_a_app_user_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buddy_pair" ADD CONSTRAINT "buddy_pair_user_b_app_user_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip" ADD CONSTRAINT "clip_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip" ADD CONSTRAINT "clip_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_vote" ADD CONSTRAINT "clip_vote_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_vote" ADD CONSTRAINT "clip_vote_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_motivation" ADD CONSTRAINT "daily_motivation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_membership" ADD CONSTRAINT "league_membership_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_membership" ADD CONSTRAINT "league_membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_clip_seen" ADD CONSTRAINT "user_clip_seen_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_clip_seen" ADD CONSTRAINT "user_clip_seen_clip_id_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_streak" ADD CONSTRAINT "user_streak_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word" ADD CONSTRAINT "user_word_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word" ADD CONSTRAINT "user_word_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_collocation" ADD CONSTRAINT "word_collocation_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_example" ADD CONSTRAINT "word_example_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_occurrence" ADD CONSTRAINT "word_occurrence_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_occurrence" ADD CONSTRAINT "word_occurrence_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writing_session" ADD CONSTRAINT "writing_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writing_summary" ADD CONSTRAINT "writing_summary_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_app_user_telegram_id" ON "app_user" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX "idx_app_user_active" ON "app_user" USING btree ("last_active_at") WHERE not "app_user"."blocked";--> statement-breakpoint
CREATE INDEX "idx_buddy_user_a" ON "buddy_pair" USING btree ("user_a");--> statement-breakpoint
CREATE INDEX "idx_buddy_user_b" ON "buddy_pair" USING btree ("user_b");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_channel_yt_id" ON "channel" USING btree ("yt_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clip_segment_word" ON "clip" USING btree ("segment_id","word_id");--> statement-breakpoint
CREATE INDEX "idx_clip_servable" ON "clip" USING btree ("word_id") WHERE "clip"."telegram_file_id" is not null and not "clip"."disabled";--> statement-breakpoint
CREATE INDEX "idx_clip_unrendered" ON "clip" USING btree ("word_id") WHERE "clip"."telegram_file_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_motivation" ON "daily_motivation" USING btree ("user_id","for_day");--> statement-breakpoint
CREATE INDEX "idx_job_run_queue_time" ON "job_run" USING btree ("queue","started_at");--> statement-breakpoint
CREATE INDEX "idx_league_week" ON "league" USING btree ("week_start","tier");--> statement-breakpoint
CREATE INDEX "idx_league_membership_board" ON "league_membership" USING btree ("league_id","points");--> statement-breakpoint
CREATE INDEX "idx_points_ledger_user_time" ON "points_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_review_event_user_time" ON "review_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_segment_video" ON "segment" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_segment_span" ON "segment" USING btree ("video_id","start_ms");--> statement-breakpoint
CREATE INDEX "idx_user_clip_seen_recency" ON "user_clip_seen" USING btree ("user_id","seen_at");--> statement-breakpoint
CREATE INDEX "idx_user_word_due" ON "user_word" USING btree ("user_id","next_review_at");--> statement-breakpoint
CREATE INDEX "idx_user_word_box" ON "user_word" USING btree ("user_id","box");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_video_yt_id" ON "video" USING btree ("yt_video_id");--> statement-breakpoint
CREATE INDEX "idx_video_channel" ON "video" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_video_pending" ON "video" USING btree ("created_at") WHERE "video"."sub_status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_video_health" ON "video" USING btree ("health_checked_at") WHERE "video"."status" = 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_word_lemma" ON "word" USING btree ("lemma");--> statement-breakpoint
CREATE INDEX "idx_word_bucket" ON "word" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "idx_word_collocation_word" ON "word_collocation" USING btree ("word_id","ord");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_word_collocation" ON "word_collocation" USING btree ("word_id","phrase");--> statement-breakpoint
CREATE INDEX "idx_word_example_word" ON "word_example" USING btree ("word_id","ord");--> statement-breakpoint
CREATE INDEX "idx_word_occurrence_lookup" ON "word_occurrence" USING btree ("word_id","quality_score");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_word_occurrence" ON "word_occurrence" USING btree ("word_id","segment_id");--> statement-breakpoint
CREATE INDEX "idx_writing_session_user" ON "writing_session" USING btree ("user_id","created_at");