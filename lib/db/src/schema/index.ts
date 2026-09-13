import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * A project document intentionally lives in JSONB rather than a collection of
 * score-specific tables. This keeps the workspace snapshot lossless as the
 * editor grows (score, conversation, undo history, onboarding, and pending
 * proposals travel together). Binary audio is never put in this document.
 */
export const projectsTable = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  version: integer("version").notNull().default(1),
  document: jsonb("document").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Metadata for microphone recordings. The bytes are in App Storage at
 * objectPath; this table only contains a private, owner-scoped pointer.
 */
export const projectAudioTable = pgTable("project_audio", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull(),
  ownerId: text("owner_id").notNull(),
  objectPath: text("object_path").notNull().unique(),
  contentType: varchar("content_type", { length: 120 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A membership checkpoint is a signed, client-persisted capability, but its
 * signature is consumed server-side exactly once. The primary key makes the
 * claim atomic across concurrent compose requests and survives reloads.
 */
export const approvalCheckpointConsumptionsTable = pgTable("approval_checkpoint_consumptions", {
  checkpointId: uuid("checkpoint_id").primaryKey(),
  signature: varchar("signature", { length: 64 }).notNull(),
  ownerId: text("owner_id").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Project = typeof projectsTable.$inferSelect;
export type NewProject = typeof projectsTable.$inferInsert;
export type ProjectAudio = typeof projectAudioTable.$inferSelect;
export type NewProjectAudio = typeof projectAudioTable.$inferInsert;
export type ApprovalCheckpointConsumption = typeof approvalCheckpointConsumptionsTable.$inferSelect;