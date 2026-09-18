import { access, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
  const normalized = normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..\\`) && !normalized.startsWith('../');
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateManifest(manifest, materialRoot, options = {}) {
  const allowMissingFiles = options.allowMissingFiles === true;
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['O manifesto precisa ser um objeto JSON.'], warnings };
  }

  if (!isSafeRelativePath(manifest.offerImage)) {
    errors.push('A imagem da oferta possui caminho inválido.');
  }

  if (!Array.isArray(manifest.documents) || manifest.documents.length !== 9) {
    errors.push('O manifesto precisa conter exatamente nove documentos.');
  } else {
    const orders = manifest.documents.map((document) => document.order).sort((a, b) => a - b);
    if (orders.join(',') !== '1,2,3,4,5,6,7,8,9') {
      errors.push('Os documentos precisam usar as ordens 1 a 9 exatamente uma vez.');
    }

    for (const document of manifest.documents) {
      if (!isSafeRelativePath(document.file)) {
        errors.push(`Documento com caminho inválido: ${String(document.file)}`);
      } else if (extname(document.file).toLowerCase() !== '.pdf') {
        errors.push(`Documento precisa usar a extensão .pdf: ${document.file}`);
      }
      if (typeof document.displayName !== 'string' || document.displayName.trim() === '') {
        errors.push(`Documento ${document.order} precisa de um nome de exibição.`);
      }
    }
  }

  if (errors.length > 0) return { errors, warnings };

  const files = [manifest.offerImage, ...manifest.documents.map((document) => document.file)];
  const missing = [];
  for (const relativePath of files) {
    if (!(await exists(resolve(materialRoot, relativePath)))) missing.push(relativePath);
  }

  if (missing.length > 0) {
    const message = `${missing.length} arquivo(s) ainda não encontrado(s): ${missing.join(', ')}`;
    if (allowMissingFiles) warnings.push(message);
    else errors.push(message);
  }

  return { errors, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const manifestArg = args.find((arg) => !arg.startsWith('--'));
  const allowMissingFiles = args.includes('--allow-missing-files');

  if (!manifestArg) {
    console.error('Uso: node scripts/validate-config.mjs <manifesto.json> [--allow-missing-files]');
    process.exitCode = 2;
    return;
  }

  try {
    const manifestPath = resolve(manifestArg);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const result = await validateManifest(manifest, dirname(manifestPath), { allowMissingFiles });

    for (const warning of result.warnings) console.log(`Aviso: ${warning}`);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`Erro: ${error}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Manifesto válido: ${manifestPath}`);
  } catch (error) {
    console.error(`Erro: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
