// src/hooks/useAnalytics.ts
/**
 * Minimal analytics shim used by the landing and explore prototypes.
 * In production this will be replaced with the real Hexclave analytics client.
 */
export const useAnalytics = () => {
  return {
    track: (event: string, payload?: Record<string, unknown>) => {
      // eslint-disable-next-line no-console
      console.log(`[Analytics] ${event}`, payload ?? {});
    },
  };
};
