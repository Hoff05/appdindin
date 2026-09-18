import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('compose pins required services without exposing postgres', async () => {
  const yaml = await readFile(new URL('compose.yaml', root), 'utf8');

  for (const name of ['postgres:', 'evolution-api:', 'n8n:', 'dashboard:']) {
    assert.match(yaml, new RegExp(`\\n  ${name}`));
  }

  assert.match(yaml, /evoapicloud\/evolution-api:v2\.3\.7/);
  assert.match(yaml, /n8nio\/n8n:2\.39\.7/);
  assert.doesNotMatch(yaml, /5432:5432/);
  assert.match(yaml, /\.\/materials:\/files:ro/);
  assert.match(yaml, /NODE_FUNCTION_ALLOW_BUILTIN: fs,path/);
  assert.match(yaml, /\.\/scripts:\/app\/scripts:ro/);
});

test('material manifest defines nine ordered PDF files', async () => {
  const source = await readFile(new URL('materials/manifest.example.json', root), 'utf8');
  const manifest = JSON.parse(source);

  assert.equal(manifest.documents.length, 9);
  assert.deepEqual(
    manifest.documents.map((item) => item.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(manifest.documents.every((item) => item.file.endsWith('.pdf')));
});

test('example environment keeps payment identity empty', async () => {
  const env = await readFile(new URL('.env.example', root), 'utf8');

  assert.match(env, /^PIX_KEY=$/m);
  assert.match(env, /^PIX_RECEIVER_NAME=$/m);
  assert.doesNotMatch(env, /48988544422|Nicolas/i);
});
