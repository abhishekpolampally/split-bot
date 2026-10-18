CREATE TABLE "expense_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"expense_id" text NOT NULL,
	"member_id" text NOT NULL,
	"amount_paise" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"payer_member_id" text NOT NULL,
	"total_paise" integer NOT NULL,
	"split_rule" text NOT NULL,
	"spec" jsonb NOT NULL,
	"proposal_id" text,
	"source_message_id" integer,
	"created_by_member_id" text,
	"confirmed_by_member_id" text,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by_member_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"invite_token" text NOT NULL,
	"created_by" text,
	"bot_busy_until" timestamp (3) with time zone,
	"bot_busy_label" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"phone" text,
	"color" text NOT NULL,
	"last_read_message_id" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"sender_member_id" text,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"proposal_id" text,
	"reply_to_id" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"sender_member_id" text,
	"source_message_id" integer,
	"status" text DEFAULT 'proposed' NOT NULL,
	"spec" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edits_expense_id" text,
	"expense_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"decided_by_member_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"from_member_id" text NOT NULL,
	"to_member_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" text DEFAULT 'upi' NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"firebase_uid" text,
	"name" text,
	"upi_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payer_member_id_members_id_fk" FOREIGN KEY ("payer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_member_id_members_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_sender_member_id_members_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_member_id_members_id_fk" FOREIGN KEY ("from_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_member_id_members_id_fk" FOREIGN KEY ("to_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_expense_idx" ON "expense_shares" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expenses_group_idx" ON "expenses" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "members_group_idx" ON "members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_group_user_uq" ON "members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_group_id_idx" ON "messages" USING btree ("group_id","id");--> statement-breakpoint
CREATE INDEX "messages_group_updated_idx" ON "messages" USING btree ("group_id","updated_at");--> statement-breakpoint
CREATE INDEX "proposals_group_idx" ON "proposals" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "settlements_group_idx" ON "settlements" USING btree ("group_id","created_at");