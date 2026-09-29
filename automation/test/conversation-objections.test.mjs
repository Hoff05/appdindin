import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const flow = JSON.parse(readFileSync(new URL('../workflows/01-whatsapp-inbound.json', import.meta.url)));
const node = name => flow.nodes.find(n => n.name === name);
async function route(text, state = 'offered', extra = {}) {
  const [event] = await Function('$json', node('Normalize Event').parameters.jsCode)({body: {event:'messages.upsert',data:{key:{id:'TEST',remoteJid:'5511999999999@s.whatsapp.net'},message:{conversation:text}}}});
  return Function('$json', node('Route State').parameters.jsCode)({...event.json, inserted:true,state,...extra})[0].json;
}
test('natural years are contextual, multiple years and special needs are not guessed', async () => {
  for (const [i,word] of ['primeiro','segundo','terceiro','quarto','quinto','sexto','sétimo','oitavo','nono'].entries()) {
    for(const text of [`${i+1}`,`${i+1}º ano`,`minha turma é ${word} ano`,`trabalho com o ${word}`,`dou aula para o ${i+1}º`]) {
      assert.equal((await route(text,'awaiting_consent')).selectedYear,i+1,text);
      assert.equal((await route(text,'new')).route,'duplicate');
    }
  }
  assert.equal((await route('trabalho do 1º ao 3º','awaiting_consent')).route,'objection');
  for(const text of ['infantil 5','meus alunos são autistas','serve para TEA?']) assert.equal((await route(text,'awaiting_consent')).route,'objection');
  assert.notEqual((await route('posso pagar dia 10?','awaiting_consent')).route,'samples');
});
test('sample appreciation is not purchase and explicit purchase is state scoped', async () => {
  for(const text of ['opa','muito bom','gostei','legal','adorei','ótimo','show','amei','bacana','interessante']) assert.equal((await route(text)).route,'objection',text);
  for(const text of ['sim!','quero sim','vou querer','pode mandar','quero comprar','vamos','fechado']) {
    assert.equal((await route(text)).route,'confirm_purchase',text);
    assert.notEqual((await route(text,'new')).route,'confirm_purchase');
  }
  for(const text of ['ok','gostei mas não quero comprar','sim, mas vou pagar depois']) assert.notEqual((await route(text)).route,'confirm_purchase');
});
test('more samples use remembered year; deferred payment and product doubts have replies', async () => {
  for(const text of ['quero ver mais','tem alguma amostra?','já comprei sem ver e me dei mal']) {
    assert.equal((await route(text,'offered',{sampleYear:4})).route,'more_samples');
    assert.equal((await route(text)).route,'objection');
  }
  for(const text of ['vou pagar depois','estou sem saldo','preciso ver meu saldo','quantas páginas tem?','vem todas as turmas?','serve para 4º ano?']) assert.equal((await route(text)).route,'objection',text);
});
test('after Pix neutral messages are silent, issues resend and explicit claims verify', async () => {
  for(const text of ['ok','entendi','beleza','tá certo','certo','show','blz','obrigada','obrigado','👍','😊','sim','feito','pronto','ainda não paguei','vou pagar']) assert.equal((await route(text,'awaiting_payment')).route,'duplicate',text);
  for(const text of ['não consigo copiar','não deu para copiar','como copia?','onde colo?','não funcionou','só apareceu uma chave','me manda o pix de novo','me confirma o pix','manda a chave','manda o código novamente']) assert.equal((await route(text,'awaiting_payment')).route,'copy_pix',text);
  for(const text of ['já paguei','fiz o pix','pagamento feito','acabei de pagar','pronto, paguei','já apareceu?','consegue verificar?','confere de novo','agora foi']) assert.equal((await route(text,'awaiting_payment')).route,'verify_payment',text);
});
test('extra samples skip sent files, keep the selected folder, and handle exhaustion', () => {
  const base = {selectedYear:4,sentSamples:['4:01.jpg','4:02.jpg','4:03.jpg']};
  const fakeFs = {existsSync:()=>true,readdirSync:()=>['06.jpg','03.jpg','02.jpg','05.jpg','01.jpg','04.jpg'],readFileSync:file=>Buffer.from(file)};
  const run = () => Function('require','$',node('Prepare More Samples').parameters.jsCode)(name => name==='fs'?fakeFs:require(name),()=>({item:{json:base}}));
  const result=run();
  assert.deepEqual(result.map(i=>i.json.sampleFileName),['04.jpg','05.jpg','06.jpg']);
  assert.ok(result.every(i=>i.json.sampleFolder==='Quarto Ano'));
  base.sentSamples.push('4:04.jpg','4:05.jpg','4:06.jpg');
  assert.equal(run()[0].json.noMoreSamples,true);
});
test('saved Pix resend payload is the exact code alone', () => {
  const code='000201TEST-CODE';
  const lookup=name=>({item:{json:name==='Route State'?{phone:'5511999999999'}:{mercadoPagoQrCode:code}}});
  const expression=node('Send Pending Mercado Pago Pix Code').parameters.body.slice(3,-2);
  assert.equal(JSON.parse(Function('$','return '+expression)(lookup)).text,code);
});
test('sample permissions and introduction cannot authorize purchase', async () => {
  for(const prompt of ['intro','year','first_year_preview','preview:3']) assert.notEqual((await route('sim','offered',{conversationPrompt:prompt})).route,'confirm_purchase');
  const question=await route('serve para terceiro?');
  assert.equal(question.nextPrompt,'preview:3');
  const answer=await route('sim','offered',{conversationPrompt:question.nextPrompt});
  assert.equal(answer.route,'samples');
  assert.equal(answer.selectedYear,3);
  assert.equal((await route('gostei','offered',{conversationPrompt:'intro'})).route,'duplicate');
});
