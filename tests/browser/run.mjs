import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, firefox } from 'playwright';

const server = spawn(process.execPath, ['tests/browser/serve.mjs'], {
  env: { ...process.env, ASB_TEST_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
});
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Fixture server did not start')), 10_000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture server exited')); });
  });
  for (const [name, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => window.browserDone, null, { timeout: 60_000 });
      const results = await page.evaluate(() => window.browserResults);
      const failed = results.filter((row) => !row.passed);
      console.log(`${name}: ${results.length - failed.length}/${results.length} DOM regressions passed`);
      if (failed.length) console.error(JSON.stringify(failed, null, 2));
      assert.deepEqual(failed, []);
      assert.deepEqual(errors, []);
      await page.goto(url + 'release-preview/options');
      await page.waitForFunction(() => document.querySelector('#counter').textContent === '0');
      assert.equal(await page.locator('#toggle-reporting').isChecked(), false);
      assert.equal(await page.locator('#export-data').isVisible(), true);
      assert.equal(await page.locator('#community-list').textContent(), 'No community entries yet.');
      assert.deepEqual(errors, []);
      await page.locator('#toggle-card-buttons').check();
      await page.waitForFunction(() => document.querySelector('#toggle-card-buttons').checked);
      const download = page.waitForEvent('download');
      await page.locator('#export-data').click();
      const file = await download;
      const { readFile } = await import('node:fs/promises');
      const exported = JSON.parse(await readFile(await file.path(), 'utf8'));
      assert.equal(exported.format, 'ai-slop-blocker');
      assert.equal(exported.settings.showCardButtons, true);
      assert.equal(exported.reportingConsent, undefined);
      await page.locator('#toggle-card-buttons').uncheck();
      assert.deepEqual(errors, []);
      console.log(`${name}: Settings renders, saves filters and downloads a portable backup with sharing off`);
      // Regenerate the actual Settings screenshot from controlled, fresh-install data.
      if (name === 'chromium' && process.env.ASB_UPDATE_SCREENSHOT === '1') {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.screenshot({ path: 'store/screenshot-settings-1280x800.png' });
      }
    } finally { await browser.close(); }
  }
} finally {
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
}
