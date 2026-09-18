import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('setup never overwrites operator configuration and prints local URLs', async () => {
  const setup = await source('scripts/setup.ps1');
  assert.match(setup, /Test-Path[\s\S]*\.env/);
  assert.match(setup, /\.env já existe|\.env existente/i);
  assert.match(setup, /Test-Path[\s\S]*manifest\.json/);
  for (const url of ['http://localhost:5678', 'http://localhost:8080/manager', 'http://localhost:3000']) {
    assert.match(setup, new RegExp(url.replace(/[/:.]/g, '\\$&')));
  }
});

test('workflow import script imports every named workflow from the mounted directory', async () => {
  const script = await source('scripts/import-workflows.ps1');
  for (const name of ['01-whatsapp-inbound.json', '02-payment-followups.json', '03-dashboard-outbox.json']) {
    assert.match(script, new RegExp(name.replace('.', '\\.')));
  }
  assert.match(script, /n8n import:workflow/);
});

test('smoke test stays local and cleans only deterministic smoke records', async () => {
  const smoke = await source('scripts/smoke-test.mjs');
  assert.match(smoke, /5511999999999/);
  assert.match(smoke, /external_id LIKE 'smoke:%'/);
  assert.match(smoke, /createRequire\(import\.meta\.url\)/);
  const urls = smoke.match(/https?:\/\/[^'"`\s]+/g) || [];
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => /^http:\/\/(localhost|127\.0\.0\.1)/.test(url)), urls.join(', '));
});

test('README documents QR connection, materials, credentials, backups and opt-out', async () => {
  const readme = await source('README.md');
  for (const phrase of ['QR Code', 'manifest.json', 'Postgres - vendas', 'backup', 'parar', 'Docker Desktop']) {
    assert.match(readme, new RegExp(phrase, 'i'));
  }
  assert.match(readme, /docker compose[^\n]+exec -T dashboard node scripts\/smoke-test\.mjs/i);
});
