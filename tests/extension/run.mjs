import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { chromium, firefox } from 'playwright';

const temp = await mkdtemp(join(tmpdir(), 'asb-extension-'));
let results = [], reportCalls = 0;
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/submit') { reportCalls++; response.end('{}'); return; }
  if (request.url === '/result') {
    let body = '';
    for await (const chunk of request) body += chunk;
    results.push(JSON.parse(body));
    response.end('ok'); return;
  }
  if (request.url.endsWith('.json')) { response.setHeader('Content-Type', 'application/json'); response.end('[]'); return; }
  if (request.url.startsWith('/search')) {
    response.end('<!doctype html><html><body><div id="rso"><section id="overview"><h2>AI Overview</h2><p>Fixture answer</p></section><article id="organic"><a href="https://example.com"><h3>Organic result</h3></a></article></div></body></html>'); return;
  }
  response.end('<!doctype html><html><body><div id="movie_player" style="position:relative;height:400px"><video class="html5-main-video"></video></div><ytd-watch-metadata><div id="owner"><ytd-channel-name><a href="/@example">Example</a></ytd-channel-name></div></ytd-watch-metadata></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function prepare(target) {
  const directory = join(temp, target);
  await cp(resolve('releases', target), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  for (const entry of manifest.content_scripts) {
    entry.matches = ['http://127.0.0.1' + (entry.js.includes('content/google.js') ? '/search*' : '/watch*')];
    entry.js.push('test-page.js');
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  let config = await readFile(join(directory, 'config.js'), 'utf8');
  config = config.replace(/export const BACKEND_URL = "[^"]+"/, `export const BACKEND_URL = "${base}"`)
    .replace(/"https:\/\/raw\.githubusercontent\.com\/[^\"]+\/videos.json"/, `"${base}/videos.json"`)
    .replace(/"https:\/\/raw\.githubusercontent\.com\/[^\"]+\/channels.json"/, `"${base}/channels.json"`);
  await writeFile(join(directory, 'config.js'), config);
  for (const [source, destination] of [['controller.js', 'options/test-controller.js'], ['page.js', 'test-page.js']]) {
    const content = (await readFile(resolve('tests/extension', source), 'utf8')).replaceAll('__TEST_ORIGIN__', base);
    await writeFile(join(directory, destination), content);
  }
  const options = join(directory, 'options/options.html');
  await writeFile(options, (await readFile(options, 'utf8')).replace('</body>', '<script src="test-controller.js"></script></body>'));
  return directory;
}
async function waitForResults(name) {
  for (let i = 0; i < 900; i++) {
    const failed = results.find((result) => !result.ok);
    if (failed) throw new Error(`${name}: ${JSON.stringify(failed)}`);
    if (['storage', 'youtube', 'google'].every((suite) => results.some((result) => result.suite === suite))) {
      assert.equal(reportCalls, 0, `${name} sent unsolicited reports`);
      console.log(`${name}: installed extension passed storage/import/export/Undo, consent, Google and YouTube recovery checks`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name}: installed-extension timeout, completed suites: ${JSON.stringify(results)}`);
}
try {
  const chromeDir = await prepare('chrome');
  const firefoxDir = await prepare('firefox');
  results = []; reportCalls = 0;
  const context = await chromium.launchPersistentContext(join(temp, 'chrome-profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${chromeDir}`, `--load-extension=${chromeDir}`],
  });
  try { await waitForResults('Chromium'); } finally { await context.close(); }
  const browsers = [['Firefox', process.env.ASB_FIREFOX_BINARY || firefox.executablePath()]];
  const zen = process.env.ASB_ZEN_BINARY || '/Applications/Zen.app/Contents/MacOS/zen';
  try { await access(zen); browsers.push(['Zen', zen]); } catch { console.log('Zen binary unavailable; Firefox is checked, native Zen smoke skipped'); }
  for (const [name, binary] of browsers) {
    results = []; reportCalls = 0;
    let output = '';
    const runner = spawn(process.execPath, [resolve('node_modules/web-ext/bin/web-ext.js'), 'run',
      '--source-dir', firefoxDir, '--firefox', binary, '--no-input', '--no-reload', '--args=-headless'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runner.stdout.on('data', (chunk) => { output += chunk; });
    runner.stderr.on('data', (chunk) => { output += chunk; });
    try { await waitForResults(name); }
    catch (error) { console.error(output.slice(-6000)); throw error; }
    finally {
      runner.kill('SIGINT');
      if (runner.exitCode === null) await Promise.race([once(runner, 'exit'), new Promise((resolve) => setTimeout(() => { runner.kill('SIGKILL'); resolve(); }, 5000))]);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
