import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/validate-workflow.mjs', import.meta.url));
const workflow = fileURLToPath(new URL('../workflows/01-whatsapp-inbound.json', import.meta.url));

test('workflow validator accepts the importable inbound workflow', () => {
  const result = spawnSync(process.execPath, [script, workflow], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid: 01-whatsapp-inbound\.json/i);
});

test('workflow validator rejects duplicate node names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zap-workflow-'));
  const target = join(directory, 'invalid.json');
  await writeFile(target, JSON.stringify({
    name: 'inválido', active: false, settings: {}, connections: {},
    nodes: [
      { id: '1', name: 'Mesmo nome', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: {} },
      { id: '2', name: 'Mesmo nome', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1, 1], parameters: {} }
    ]
  }));
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nome de nó duplicado/i);
});

test('workflow validator rejects a workflow without an import id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zap-workflow-id-'));
  const target = join(directory, 'missing-id.json');
  await writeFile(target, JSON.stringify({
    name: 'sem id', active: false, settings: {}, connections: {},
    nodes: [{ id: '1', name: 'Código', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: {} }],
  }));
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workflow sem id/i);
});
