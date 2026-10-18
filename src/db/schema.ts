import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SplitSpec, SplitResult } from "@/lib/split/types";

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const users = pgTable("users", {
  id: id(),
  phone: text("phone").notNull().unique(),
  /** Firebase Auth uid of the phone sign-in; set on first Firebase login. */
  firebaseUid: text("firebase_uid").unique(),
  name: text("name"),
  upiId: text("upi_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Firebase Cloud Messaging tokens, one per browser/device a user enabled notifications on. */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [index("push_tokens_user_idx").on(t.userId)],
);

// Legacy: codes from the pre-Firebase OTP login. Nothing reads it any more; drop it in a later
// migration once the Firebase login is deployed (the old deployment still writes to it).
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: id(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("otp_phone_idx").on(t.phone, t.createdAt)],
);

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const groups = pgTable("groups", {
  id: id(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  inviteToken: text("invite_token").notNull().unique(),
  createdBy: text("created_by").references(() => users.id),
  botBusyUntil: ts("bot_busy_until"),
  botBusyLabel: text("bot_busy_label"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * A member of a group. `userId` is null for placeholder members — people added
 * by name who haven't joined yet. The ledger always refers to members, so a
 * placeholder can be part of splits and later be claimed by a real user.
 */
export const members = pgTable(
  "members",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    phone: text("phone"),
    color: text("color").notNull(),
    lastReadMessageId: integer("last_read_message_id").notNull().default(0),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [
    index("members_group_idx").on(t.groupId),
    uniqueIndex("members_group_user_uq").on(t.groupId, t.userId),
  ],
);

export type MessageKind =
  | "text" // human message
  | "bot_text" // plain bot reply
  | "proposal" // bot proposal card (proposalId set)
  | "clarify" // bot question with tappable options
  | "summary" // bot post-confirm standings
  | "settle" // bot settle-up suggestion
  | "system"; // centred grey notice

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    senderMemberId: text("sender_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<MessageKind>().notNull(),
    body: text("body").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>(),
    proposalId: text("proposal_id"),
    replyToId: integer("reply_to_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_group_id_idx").on(t.groupId, t.id),
    index("messages_group_updated_idx").on(t.groupId, t.updatedAt),
  ],
);

export type ProposalStatus = "proposed" | "confirmed" | "cancelled" | "superseded";

export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    senderMemberId: text("sender_member_id").references(() => members.id),
    sourceMessageId: integer("source_message_id"),
    status: text("status").$type<ProposalStatus>().notNull().default("proposed"),
    spec: jsonb("spec").$type<SplitSpec>().notNull(),
    result: jsonb("result").$type<SplitResult>().notNull(),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    /** Set when this proposal edits an already-confirmed expense. */
    editsExpenseId: text("edits_expense_id"),
    expenseId: text("expense_id"),
    version: integer("version").notNull().default(1),
    decidedByMemberId: text("decided_by_member_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("proposals_group_idx").on(t.groupId, t.createdAt)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    category: text("category").notNull().default("other"),
    payerMemberId: text("payer_member_id")
      .notNull()
      .references(() => members.id),
    totalPaise: integer("total_paise").notNull(),
    splitRule: text("split_rule").notNull(),
    spec: jsonb("spec").$type<SplitSpec>().notNull(),
    proposalId: text("proposal_id"),
    sourceMessageId: integer("source_message_id"),
    createdByMemberId: text("created_by_member_id"),
    confirmedByMemberId: text("confirmed_by_member_id"),
    deletedAt: ts("deleted_at"),
    deletedByMemberId: text("deleted_by_member_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("expenses_group_idx").on(t.groupId, t.createdAt)],
);

export const expenseShares = pgTable(
  "expense_shares",
  {
    id: id(),
    expenseId: text("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    amountPaise: integer("amount_paise").notNull(),
  },
  (t) => [index("shares_expense_idx").on(t.expenseId)],
);

export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    fromMemberId: text("from_member_id")
      .notNull()
      .references(() => members.id),
    toMemberId: text("to_member_id")
      .notNull()
      .references(() => members.id),
    amountPaise: integer("amount_paise").notNull(),
    method: text("method").notNull().default("upi"),
    createdByMemberId: text("created_by_member_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("settlements_group_idx").on(t.groupId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Member = typeof members.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
