import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('n8n workflows do not require broad environment access inside nodes', async () => {
  const compose = await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const n8nService = compose.match(/  n8n:[\s\S]*?\n  dashboard:/)?.[0] ?? '';

  assert.doesNotMatch(compose, /N8N_BLOCK_ENV_ACCESS_IN_NODE:\s*"false"/);
  assert.doesNotMatch(n8nService, /EVOLUTION_API_KEY:/);
  assert.doesNotMatch(n8nService, /EVOLUTION_INSTANCE:/);

  for (const file of [
    '../workflows/01-whatsapp-inbound.json',
    '../workflows/02-payment-followups.json',
    '../workflows/03-dashboard-outbox.json',
  ]) {
    const workflow = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /\$env\./, `${file} still reads $env`);
  }
});
