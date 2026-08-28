/*
 * ProjectStore abstraction – provides a unified interface for persisting
 * BrickWrite projects either locally (IndexedDB) or remotely (Convex).
 *
 * The local implementation simply forwards calls to the existing
 * ProjectRepository defined in `src/cad/persistence.ts`. The remote version
 * is a stub that will later use Convex APIs.
 */

import type { ModelDocument } from '../cad/types';
import type { ProjectSummary } from '../cad/persistence';
import { createRepository } from '../cad/persistence';
import { getConvexClient } from './convexClient';

/** Minimal project payload returned by `loadProject`. */
export interface LoadedProject {
  document: ModelDocument;
  /** Transactions replayed after the last checkpoint. */
  replayed: any[]; // placeholder – actual type defined by persistence layer
}

/** Unified store interface used by the session layer. */
export interface ProjectStore {
  /** List all projects visible to the current user. */
  listProjects(): Promise<ProjectSummary[]>;
  /** Load a project by its id. */
  loadProject(projectId: string): Promise<LoadedProject | null>;
  /** Persist a full document checkpoint. */
  saveCheckpoint(document: ModelDocument): Promise<void>;
  /** Delete a stored project. */
  deleteProject(projectId: string): Promise<void>;
}

/** Local IndexedDB implementation – thin wrapper around the existing repo. */
export class IndexedDbProjectStore implements ProjectStore {
  private repo = createRepository();

  async listProjects() {
    return this.repo.listProjects();
  }
  async loadProject(projectId: string) {
    const loaded = await this.repo.loadProject(projectId);
    if (!loaded) return null;
    // The legacy repository returns {document, replayed}
    return loaded as LoadedProject;
  }
  async saveCheckpoint(document: ModelDocument) {
    await this.repo.saveCheckpoint(document);
  }
  async deleteProject(projectId: string) {
    await this.repo.deleteProject(projectId);
  }
}

/** Remote Convex implementation – currently a stub. */
export class ConvexProjectStore implements ProjectStore {
  private client = getConvexClient();
  async listProjects() {
    // Convex query returns an array of ProjectSummary objects
    // The server-side function name is "listProjects"
    const result = await this.client.query('listProjects');
    return result as any;
  }
  async loadProject(projectId: string) {
    // Convex query returns a LoadedProject or null
    const result = await this.client.query('loadProject', { projectId });
    return result as any;
  }
  async saveCheckpoint(document: ModelDocument) {
    // Convex mutation to persist a checkpoint document
    await this.client.mutation('saveCheckpoint', { document });
  }
  async deleteProject(projectId: string) {
    await this.client.mutation('deleteProject', { projectId });
  }
}
