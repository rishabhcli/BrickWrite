// Convex client wrapper for BrickWrite
// Uses the Vite env variable VITE_CONVEX_URL to initialise the browser client.

import { ConvexReactClient } from "convex/react";

let client: ConvexReactClient | null = null;

export function getConvexClient(): ConvexReactClient {
  if (client) return client;
  const url = import.meta.env.VITE_CONVEX_URL as string;
  if (!url) {
    throw new Error("VITE_CONVEX_URL is not defined. Set it in your .env or Vite config.");
  }
  client = new ConvexHttpClient(url);
  return client;
}
