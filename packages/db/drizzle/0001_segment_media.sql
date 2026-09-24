CREATE TYPE "public"."media_status" AS ENUM('none', 'rendered', 'failed');--> statement-breakpoint
CREATE TABLE "segment_media" (
	"segment_id" bigint PRIMARY KEY NOT NULL,
	"telegram_file_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"width" smallint,
	"height" smallint,
	"size_bytes" integer,
	"aligned" boolean DEFAULT false NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"dislikes" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"rendered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_vote" (
	"user_id" integer NOT NULL,
	"segment_id" bigint NOT NULL,
	"vote" "vote_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_vote_user_id_segment_id_pk" PRIMARY KEY("user_id","segment_id")
);
--> statement-breakpoint
CREATE TABLE "user_segment_seen" (
	"user_id" integer NOT NULL,
	"segment_id" bigint NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_segment_seen_user_id_segment_id_pk" PRIMARY KEY("user_id","segment_id")
);
--> statement-breakpoint
CREATE TABLE "video_subtitle" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"lang" varchar(16),
	"vtt" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "aligned_start_ms" integer;--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "aligned_end_ms" integer;--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "align_score" real;--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "word_timings" jsonb;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "feed_index" integer;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "media_status" "media_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "media_rendered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "segment_media" ADD CONSTRAINT "segment_media_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_vote" ADD CONSTRAINT "segment_vote_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_vote" ADD CONSTRAINT "segment_vote_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_segment_seen" ADD CONSTRAINT "user_segment_seen_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_segment_seen" ADD CONSTRAINT "user_segment_seen_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_subtitle" ADD CONSTRAINT "video_subtitle_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_segment_media_servable" ON "segment_media" USING btree ("segment_id") WHERE not "segment_media"."disabled";--> statement-breakpoint
CREATE INDEX "idx_user_segment_seen_recency" ON "user_segment_seen" USING btree ("user_id","seen_at");--> statement-breakpoint
CREATE INDEX "idx_segment_fts" ON "segment" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "idx_video_feed" ON "video" USING btree ("channel_id","feed_index");