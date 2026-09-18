import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export function validateWorkflow(workflow) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object') return ['O workflow precisa ser um objeto JSON.'];
  if (typeof workflow.id !== 'string' || !workflow.id.trim()) errors.push('Workflow sem ID para importação.');
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) errors.push('Workflow sem nome.');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) return [...errors, 'Workflow sem nós.'];
  if (!workflow.connections || typeof workflow.connections !== 'object') errors.push('Workflow sem conexões.');

  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (!node.id || ids.has(node.id)) errors.push(`ID de nó ausente ou duplicado: ${node.id || '(vazio)'}`);
    if (!node.name || names.has(node.name)) errors.push(`Nome de nó duplicado: ${node.name || '(vazio)'}`);
    ids.add(node.id);
    names.add(node.name);
    if (!node.type || node.typeVersion == null || !Array.isArray(node.position)) {
      errors.push(`Nó incompleto: ${node.name || node.id}`);
    }
  }

  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    if (!names.has(source)) errors.push(`Conexão parte de nó inexistente: ${source}`);
    for (const outputType of Object.values(outputs)) {
      for (const group of outputType || []) {
        for (const edge of group || []) {
          if (!names.has(edge.node)) errors.push(`Conexão aponta para nó inexistente: ${edge.node}`);
        }
      }
    }
  }

  const serialized = JSON.stringify(workflow);
  if (/48988544422|Nicolas B/i.test(serialized)) errors.push('O workflow contém dados pessoais copiados do vídeo.');
  if (/"apikey"\s*:\s*"(?!={{)/i.test(serialized)) errors.push('O workflow parece conter uma chave de API fixa.');
  return errors;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Uso: node validate-workflow.mjs <workflow.json> [...]');
    process.exitCode = 2;
    return;
  }
  for (const file of files) {
    try {
      const workflow = JSON.parse(await readFile(resolve(file), 'utf8'));
      const errors = validateWorkflow(workflow);
      if (errors.length) {
        for (const error of errors) console.error(`invalid: ${basename(file)}: ${error}`);
        process.exitCode = 1;
      } else {
        console.log(`valid: ${basename(file)}`);
      }
    } catch (error) {
      console.error(`invalid: ${basename(file)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

await main();
