// Convex schema for BrickWrite cloud persistence.
// This file defines tables that mirror the local IndexedDB structure.
// The actual schemas will be fleshed out in future work.

import { v } from 'convex/values';

export default defineSchema({
  projects: v.object({
    projectId: v.string(),
    name: v.string(),
    ownerId: v.string(),
    createdAt: v.string(),
    // Additional metadata fields can be added here.
  }),
  // Placeholder tables – details to be specified later.
  branches: v.object({}),
  versions: v.object({}),
  transactions: v.object({}),
  snapshots: v.object({}),
  files: v.object({}),
  members: v.object({}),
  invitations: v.object({}),
  presence: v.object({}),
  auditEvents: v.object({}),
  comments: v.object({}),
});
