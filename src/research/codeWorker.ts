import { parentPort } from 'node:worker_threads';
import {
  extractCodeStructure, type CodeSourceInput,
} from './codeStructure.js';

parentPort?.on('message', (inputs: CodeSourceInput[]) => {
  try {
    parentPort?.postMessage({ result: extractCodeStructure(inputs) });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
