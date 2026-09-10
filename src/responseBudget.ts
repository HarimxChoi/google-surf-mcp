export function adaptiveResponseBudget(items: number, groups = 1, families = 1): number {
  // Grow with evidence breadth, not database size or repeated output volume.
  return Math.ceil(2_000 + 2_000 * Math.log2(1 + Math.max(0, items))
    + 1_000 * Math.log2(Math.max(1, groups)) + 500 * Math.log2(Math.max(1, families)));
}

export function adaptiveOutputBudget(evidenceBlocks: number): number {
  return Math.min(6_000, Math.ceil(2_000 + 1_000 * Math.log2(Math.max(1, evidenceBlocks))));
}
