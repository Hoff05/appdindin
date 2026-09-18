import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/validate-config.mjs', import.meta.url));

async function runValidator(manifest, extraArgs = []) {
  const directory = await mkdtemp(join(tmpdir(), 'zap-manifest-'));
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  const result = spawnSync(process.execPath, [script, manifestPath, ...extraArgs], {
    cwd: directory,
    encoding: 'utf8',
  });
  return { ...result, directory };
}

function manifestWith(files = Array.from({ length: 9 }, (_, index) => `ano-${index + 1}.pdf`)) {
  return {
    offerImage: 'oferta.jpg',
    driveUrl: '',
    documents: files.map((file, index) => ({
      order: index + 1,
      file,
      displayName: `Atividades ${index + 1}`,
    })),
  };
}

test('validator rejects parent traversal in a material path', async () => {
  const manifest = manifestWith();
  manifest.documents[0].file = '../segredo.pdf';
  const result = await runValidator(manifest, ['--allow-missing-files']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caminho inválido/i);
});

test('validator requires each order from one through nine exactly once', async () => {
  const manifest = manifestWith();
  manifest.documents[8].order = 8;
  const result = await runValidator(manifest, ['--allow-missing-files']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ordens 1 a 9/i);
});

test('validator can report user-selected files as warnings', async () => {
  const result = await runValidator(manifestWith(), ['--allow-missing-files']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /válido/i);
  assert.match(result.stdout, /10 arquivo\(s\) ainda não encontrado\(s\)/i);
});
