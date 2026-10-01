CREATE TABLE "word_detail" (
	"word_id" integer PRIMARY KEY NOT NULL,
	"parts_of_speech" text[] NOT NULL,
	"family" jsonb DEFAULT '[]' NOT NULL,
	"base_word" varchar(64),
	"synonyms" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "writing_session" ADD COLUMN "scores" jsonb;--> statement-breakpoint
ALTER TABLE "word_detail" ADD CONSTRAINT "word_detail_word_id_word_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."word"("id") ON DELETE cascade ON UPDATE no action;