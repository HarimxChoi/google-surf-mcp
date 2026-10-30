import { existsSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(Buffer.from(process.env.SURF_RESEARCH_BROKER_CONFIG, 'base64url').toString('utf8'));
const rss = process.memoryUsage.rss;
process.memoryUsage.rss = () => existsSync(join(config.root, 'pressure-on')) ? 2 ** 31 : rss();
await import('../../build/research/brokerProcess.js');
