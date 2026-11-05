import { z } from "zod";

export const nunTemporalStateSchema = z.object({
  modelId: z.string().min(1).max(128),
  modelVersion: z.string().min(1).max(64),
  clock: z.object({
    logicalStep: z.number().int().nonnegative().safe(),
    physicalTimestamp: z.string().datetime({ offset: true }),
    epoch: z.string().min(1).max(128),
  }).strict(),
  fastState: z.object({ values: z.array(z.number().finite()).min(1).max(4096), dimension: z.number().int().positive().max(4096) }).strict(),
  slowState: z.object({ values: z.array(z.number().finite()).min(1).max(4096), dimension: z.number().int().positive().max(4096) }).strict(),
  uncertainty: z.object({
    representation: z.literal("diagonal"),
    values: z.array(z.number().finite().positive()).min(1).max(8192),
    semantics: z.enum(["variance", "standard_deviation"]),
  }).strict(),
  transition: z.object({
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousStateHash: z.string().regex(/^[a-f0-9]{64}$/),
    predictedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  metadata: z.object({
    units: z.array(z.string().min(1).max(64)).max(8192),
    coordinateSystem: z.string().min(1).max(128),
    assumptions: z.array(z.string().max(1000)).max(100),
  }).strict(),
}).strict();

export type NuNTemporalState = z.infer<typeof nunTemporalStateSchema>;

export function validateNuNTemporalState(input: unknown): NuNTemporalState {
  const state = nunTemporalStateSchema.parse(input);
  if (state.fastState.values.length !== state.fastState.dimension) throw new Error("BRIDGE_FAST_DIMENSION_MISMATCH");
  if (state.slowState.values.length !== state.slowState.dimension) throw new Error("BRIDGE_SLOW_DIMENSION_MISMATCH");
  if (state.uncertainty.values.length !== state.fastState.dimension + state.slowState.dimension) {
    throw new Error("BRIDGE_UNCERTAINTY_DIMENSION_MISMATCH");
  }
  if (state.metadata.units.length !== state.uncertainty.values.length) throw new Error("BRIDGE_UNITS_DIMENSION_MISMATCH");
  return state;
}
