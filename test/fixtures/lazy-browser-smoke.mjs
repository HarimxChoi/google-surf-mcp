import { chromium as bare } from 'playwright';
import { chromium as extra } from 'playwright-extra';
for (const browser of [bare, extra]) {
  browser.launch = browser.launchPersistentContext = async () => {
    process.stderr.write('SURF_SMOKE_BROWSER_ATTEMPT\n');
    throw new Error('fixture blocked browser launch before any network request');
  };
}
