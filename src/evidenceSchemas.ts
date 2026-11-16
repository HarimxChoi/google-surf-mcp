import { z } from 'zod';
import type { EvidenceRange } from './evidence.js';

// Homogeneous items work in both draft-7 and 2020-12 tool-schema validators.
export const ExcludedEvidenceRangeSchema = z.array(z.number().int().min(0)).length(2)
  .refine(range => range[1] > range[0], 'end must exceed start')
  .transform(([start, end]): EvidenceRange => [start, end]);
