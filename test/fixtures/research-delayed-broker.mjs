import { ResearchStore } from '../../build/research/store.js';

const searchExact = ResearchStore.prototype.searchProjectExact;
ResearchStore.prototype.searchProjectExact = async function (...args) {
  if (args[1] === 'native-deadline-fixture') {
    const db = await this.open();
    await db.query('SLEEP 2s;').collect();
  }
  return await searchExact.apply(this, args);
};

await import('../../build/research/brokerProcess.js');
