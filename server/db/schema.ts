import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const author = sqliteTable("author", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  platform: text("platform", { enum: ["youtube", "x"] }).notNull(),
  platformId: text("platform_id").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const authorRelations = relations(author, ({ many }) => ({
  originalPosts: many(originalPost),
}));

export const originalPost = sqliteTable("original_post", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  authorId: integer("author_id", { mode: "number" }).references(() => author.id),
  platform: text("platform", { enum: ["youtube", "x"] }).notNull(),
  postUrl: text("post_url").notNull(),
  title: text("title"),
  description: text("description"),
  subtitlesJson: text("subtitles_json"),
  coverImageUrl: text("cover_image_url"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const originalPostRelations = relations(originalPost, ({ one, many }) => ({
  author: one(author, {
    fields: [originalPost.authorId],
    references: [author.id],
  }),
  clips: many(clips),
}));

export const clips = sqliteTable("clips", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  originalPostId: integer("original_post_id", { mode: "number" }).references(() => originalPost.id),
  fileName: text("file_name").notNull(),
  clipUrl: text("clip_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  startTime: real("start_time"),
  endTime: real("end_time"),
  duration: text("duration"),
  title: text("title"),
  size: integer("size", { mode: "number" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const clipsRelations = relations(clips, ({ one, many }) => ({
  originalPost: one(originalPost, {
    fields: [clips.originalPostId],
    references: [originalPost.id],
  }),
  shots: many(shots),
}));

export const shots = sqliteTable("shots", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  clipId: integer("clip_id", { mode: "number" }).references(() => clips.id),
  idx: integer("idx", { mode: "number" }).notNull(),
  clipUrl: text("clip_url"),
  thumbnailUrl: text("thumbnail_url"),
  size: integer("size", { mode: "number" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const shotsRelations = relations(shots, ({ one }) => ({
  clip: one(clips, {
    fields: [shots.clipId],
    references: [clips.id],
  }),
}));