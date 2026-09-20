'use strict';

const DEFAULT_MESSAGE_SETTINGS = {
  steps: {
    offer_greeting: { label: 'Saudação', type: 'text', enabled: true, delayMs: 900, text: 'Olá, Tudo bem? 😊' },
    offer_context: { label: 'Contexto', type: 'text', enabled: true, delayMs: 900, text: 'Separei um material lindo e super fácil de aplicar que várias pessoas estão amando usar no dia a dia 💗' },
    offer_welcome: { label: 'Boas-vindas', type: 'text', enabled: true, delayMs: 900, text: 'Fico feliz de ter você por aqui! ❤️' },
    offer_contact: { label: 'Adicionar contato', type: 'text', enabled: true, delayMs: 900, text: 'Me adiciona nos contatos para não perder nossa conversa, tá?' },
    offer_image: { label: 'Imagem da oferta', type: 'image', enabled: true, delayMs: 1000, fileName: 'oferta.jpg', caption: 'Kit de Matemática — 887 atividades do 1º ao 9º ano' },
    offer_details: { label: 'Título dos benefícios', type: 'text', enabled: true, delayMs: 900, text: 'O que você vai receber' },
    offer_benefits: { label: 'Benefícios', type: 'text', enabled: true, delayMs: 900, text: '✅ +887 Atividades do 1º ao 9º ano\n✅ Material pronto para imprimir\n✅ Conteúdo 100% digital\n✅ PDFs didáticos e coloridos\n✅ Acesso vitalício\n\nE outros bônus exclusivos...' },
    offer_price: { label: 'Preço', type: 'text', enabled: true, delayMs: 900, text: '💰 Tudo isso por apenas R$ {{price}} pagamento único.' },
    offer_commitment: { label: 'Confiança', type: 'text', enabled: true, delayMs: 900, text: 'Para mostrar nossa confiança e compromisso, enviamos todo o material primeiro antes do pagamento.\n\nApós receber as apostilas e os bônus é necessário o envio do pix de R${{price}}' },
    offer_trust: { label: 'Pergunta final', type: 'text', enabled: true, delayMs: 900, text: 'posso confiar que após eu te mandar nosso material você faz o pagamento dos R$ 10 reais??' },
    materials_reaction: { label: 'Reação na resposta', type: 'reaction', enabled: true, delayMs: 0, text: '👏' },
    materials_intro: { label: 'Aviso de envio', type: 'text', enabled: true, delayMs: 900, text: '😍 Vou te enviar!! 🙏' },
    materials_details: { label: 'Texto antes dos PDFs', type: 'text', enabled: true, delayMs: 900, text: 'Segue pdf das atividades amiga' },
    materials_pdfs: { label: 'Enviar PDFs', type: 'pdfs', enabled: true, delayMs: 0, text: 'Enviar os PDFs do manifesto' },
    pix_intro: { label: 'Mensagem pós-PDF', type: 'text', enabled: true, delayMs: 900, text: 'Todas as outras atividades, dinâmicas e exercícios estão no material enviado.' },
    pix_values: { label: 'Valores Pix', type: 'pix', enabled: true, delayMs: 900, text: 'Escolha um dos valores abaixo:\n\nO valor de R$ {{price}} é o padrão do material. Os outros valores são para quem quiser apoiar esse projeto e ajudar a continuar criando mais materiais prontos para professoras ❤️\n\n💰 R$10,00\n💰 R$14,90\n💰 R$19,90\n💰 R$29,90\n💰 R$49,90\n❤️ Ou o valor que o seu coração mandar.' },
    pix_access: { label: 'Acesso', type: 'text', enabled: true, delayMs: 900, text: 'Pagamento único.\n\n🖨️ Imprima quantas vezes desejar\n📱 Acesso imediato' },
    pix_key: { label: 'Chave Pix', type: 'pix', enabled: true, delayMs: 900, text: 'Copiar e colar no seu app ⬇️\n\n📌 Pagamento via PIX: {{pixKeyType}}\n🔑 {{pixKey}}\n👤 {{pixReceiverName}}' },
    pix_receipt: { label: 'Pedido de comprovante', type: 'text', enabled: true, delayMs: 900, text: 'Após o pagamento, por favor, envie o comprovante para que possamos registrar no sistema, tudo bem? 😊' },
  },
  followups: {
    first: { label: 'Cobrança 1', enabled: true, delayMinutes: 15, messages: ['Você conseguiu efetuar o pagamento?'] },
    second: { label: 'Cobrança 2', enabled: true, delayMinutes: 60, messages: ['Oi {{firstName}}, deu certo o pagamento?'] },
    third: { label: 'Cobrança 3', enabled: true, delayMinutes: 91, messages: ['Oi Prof!', 'Vi que você ainda não finalizou seu acesso...', 'Você consegue honrar com o compromisso que fizemos no começo da conversa?'] },
  },
};

const STEP_ORDER = Object.keys(DEFAULT_MESSAGE_SETTINGS.steps);
const FOLLOWUP_ORDER = Object.keys(DEFAULT_MESSAGE_SETTINGS.followups);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(value) {
  const settings = deepClone(DEFAULT_MESSAGE_SETTINGS);
  const source = value && typeof value === 'object' ? value : {};
  for (const key of STEP_ORDER) {
    if (source.steps?.[key]) settings.steps[key] = { ...settings.steps[key], ...source.steps[key] };
  }
  for (const key of FOLLOWUP_ORDER) {
    if (source.followups?.[key]) settings.followups[key] = { ...settings.followups[key], ...source.followups[key] };
  }
  return settings;
}

function parseStoredSettings(value) {
  if (!value) return mergeSettings({});
  try {
    return mergeSettings(JSON.parse(value));
  } catch {
    return mergeSettings({});
  }
}

function normalizeBoolean(value) {
  return value === 'on' || value === 'true' || value === true;
}

function normalizeDelayMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 3600000) return fallback;
  return Math.round(number);
}

function normalizeDelayMinutes(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10080) return fallback;
  return Math.round(number);
}

function settingsFromForm(body) {
  const current = mergeSettings({});
  for (const key of STEP_ORDER) {
    const existing = current.steps[key];
    current.steps[key] = {
      ...existing,
      enabled: normalizeBoolean(body[`step_${key}_enabled`]),
      delayMs: normalizeDelayMs(body[`step_${key}_delayMs`], existing.delayMs),
      text: String(body[`step_${key}_text`] ?? existing.text ?? '').slice(0, 4000),
      caption: String(body[`step_${key}_caption`] ?? existing.caption ?? '').slice(0, 1000),
      fileName: String(body[`step_${key}_fileName`] ?? existing.fileName ?? '').replace(/[\\/]/g, '').slice(0, 200),
    };
  }
  for (const key of FOLLOWUP_ORDER) {
    const existing = current.followups[key];
    const rawMessages = String(body[`followup_${key}_messages`] ?? existing.messages.join('\n')).split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 5);
    current.followups[key] = {
      ...existing,
      enabled: normalizeBoolean(body[`followup_${key}_enabled`]),
      delayMinutes: normalizeDelayMinutes(body[`followup_${key}_delayMinutes`], existing.delayMinutes),
      messages: rawMessages.length ? rawMessages : existing.messages,
    };
  }
  return current;
}

module.exports = {
  DEFAULT_MESSAGE_SETTINGS,
  STEP_ORDER,
  FOLLOWUP_ORDER,
  parseStoredSettings,
  settingsFromForm,
};
