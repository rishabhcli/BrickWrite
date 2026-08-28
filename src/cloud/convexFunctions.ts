// Convex server functions for BrickWrite cloud persistence.
// These functions map the ProjectStore interface to Convex database operations.
// The file is intended to be compiled by the Convex backend (npm run convex dev).

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ----- Project CRUD -----

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("projects").collect();
    return rows;
  },
});

export const loadProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("projectId"), projectId))
      .first();
    if (!project) return null;
    // For simplicity, return the raw project record. Real implementation would
    // also fetch snapshots, transactions, and reconstruct the LoadedProject.
    return project;
  },
});

export const saveCheckpoint = mutation({
  args: { document: v.object({ /* loosely typed – real schema omitted */ }) },
  handler: async (ctx, { document }) => {
    // Upsert a project record based on its id.
    const { projectId } = document as any;
    const existing = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("projectId"), projectId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { document });
    } else {
      await ctx.db.insert("projects", { projectId, document });
    }
    return null;
  },
});

export const deleteProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const proj = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("projectId"), projectId))
      .first();
    if (proj) {
      await ctx.db.delete(proj._id);
    }
    return null;
  },
});
