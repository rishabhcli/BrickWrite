import { z } from 'zod'

const base = {
  originLdu: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  anchorPartId: z.string().min(1).max(80).optional(),
  color: z.number().int().min(0).max(999999).optional(),
}
/** Dedicated strict schemas, registered by the shared capability schema table. */
export const MECHANISM_SCHEMAS = {
  build_crane: z.strictObject({ ...base, boomStuds: z.number().int().min(2).max(64) }),
  build_lattice: z.strictObject({
    ...base, widthStuds: z.number().int().min(3).max(32), depthStuds: z.number().int().min(3).max(32),
    heightCourses: z.number().int().min(1).max(16), bayStuds: z.number().int().min(2).max(16),
  }),
  build_snot_hull: z.strictObject({
    ...base, widthStuds: z.number().int().min(3).max(32), depthStuds: z.number().int().min(3).max(32), layers: z.number().int().min(1).max(2),
  }),
  build_clock_faces: z.strictObject({ ...base, diameterStuds: z.number().int().min(4).max(16) }),
} as const
