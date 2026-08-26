import { parentPort, workerData } from 'node:worker_threads';
import type { GraphProjection } from './contracts.js';
import { analyzeGraphProjection } from './graphSidecar.js';

const input = workerData as {
  projection: GraphProjection;
  options: { seeds?: string[]; source?: string; target?: string };
};

parentPort?.postMessage(analyzeGraphProjection(input.projection, input.options));
