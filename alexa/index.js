// Skill Alexa "Lavastoviglie di casa" - stessa logica della web app (ntfy + Google Foglio)
const Alexa = require('ask-sdk-core');
const https = require('https');

const TOPIC = 'lavastoviglie-ste-8ngizkhq';
const STATE_TOPIC = TOPIC + '-stato';
const NTFY = 'https://ntfy.sh';
const SHEET_API = 'https://script.google.com/macros/s/AKfycbzYMdjA9kwTIPMxDNcL3fdRcOh9ksxUvr1hXLUSek8CYRPTK30Txcy8tjCHt_jQR_8m/exec';

const PROGS = {
  misti: { n: 'Misti',          t: '55°', m: 145, kwh: 1.35, litri: 16,   voce: 'Misti 55 gradi' },
  eco:   { n: 'Eco',            t: '50°', m: 270, kwh: 0.95, litri: 12,   voce: 'Eco 50 gradi' },
  int:   { n: 'Intensivo',      t: '65°', m: 150, kwh: 1.5,  litri: 16,   voce: 'Intensivo 65 gradi' },
  push:  { n: 'Push&GO',        t: '50°', m: 85,  kwh: 1.1,  litri: 11.5, voce: 'Push and Go' },
  fast:  { n: "Fast&Clean 28'", t: '45°', m: 28,  kwh: 0.6,  litri: 9,    voce: 'Fast and Clean' },
  prova: { n: 'PROVA',          t: "2'",  m: 2,   kwh: 0,    litri: 0,    voce: 'prova di 2 minuti', test: true }
};

// ---------- rete ----------
function request(url, method = 'GET', body = null, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: body ? { 'Content-Type': 'text/plain; charset=utf-8' } : {} }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), 'GET', null, hops + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
const qs = o => new URLSearchParams(o).toString();
// Invia la richiesta senza aspettare la risposta di Google (che impiega ~4 secondi):
// lo script parte comunque appena la richiesta è arrivata. Alexa ha solo 8 secondi per rispondere.
function fire(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'GET' }, res => res.resume());
    req.on('error', () => resolve());
    req.on('finish', () => setTimeout(resolve, 300));
    setTimeout(resolve, 2500);
    req.end();
  });
}
const sheetFire = params => fire(`${SHEET_API}?${qs(params)}`);
const sheet = async params => { try { return JSON.parse((await request(`${SHEET_API}?${qs(params)}`)).text); } catch (e) { return null; } };
const publishState = obj => request(`${NTFY}/${STATE_TOPIC}`, 'POST', JSON.stringify(obj)).catch(() => {});
const notify = (title, msg, tags) => request(`${NTFY}/${TOPIC}?${qs({ title, tags })}`, 'POST', msg).catch(() => {});

// ---------- stato attuale (ricostruito dal canale "muto" di ntfy) ----------
async function currentCycle() {
  const r = await request(`${NTFY}/${STATE_TOPIC}/json?poll=1&since=12h`);
  let cur = null;
  for (const line of r.text.trim().split('\n').filter(Boolean)) {
    let a; try { a = JSON.parse(JSON.parse(line).message || '{}'); } catch (e) { continue; }
    if (a.a === 'start') cur = a;
    else if ((a.a === 'cancel' || a.a === 'done') && cur && cur.seq === a.seq) cur = null;
    else if (a.a === 'end' && cur && cur.seq === a.seq) cur = Object.assign({}, cur, { end: a.end });
  }
  if (cur && Date.now() - cur.end > 3 * 3600000) cur = null;
  return cur;
}

// ---------- utilità ----------
function durOf(key, archive) {
  const p = PROGS[key];
  if (p.test || !archive) return p.m;
  const reals = archive.lavaggi.filter(l => l.prog === p.n && l.reale > 0 && l.reale < p.m && l.stato !== 'annullato')
    .sort((a, b) => b.t - a.t).slice(0, 5).map(l => l.reale).sort((a, b) => a - b);
  if (!reals.length) return p.m;
  const mid = reals.length >> 1;
  return Math.round(reals.length % 2 ? reals[mid] : (reals[mid - 1] + reals[mid]) / 2);
}
function oraVoce(ms) {
  const [h, m] = new Date(ms).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return m === 0 ? `alle ${h} in punto` : `alle ${h} e ${m}`;
}
function oraTesto(ms) {
  return new Date(ms).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
}
function durataVoce(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const hs = h === 1 ? '1 ora' : `${h} ore`, ms = m === 1 ? '1 minuto' : `${m} minuti`;
  return h && m ? `${hs} e ${ms}` : h ? hs : ms;
}
function pillsLeft(a) {
  if (!a || !a.pastiglie || !a.pastiglie.length) return null;
  const last = a.pastiglie.reduce((x, y) => (y.t > x.t ? y : x));
  return Math.max(0, last.qty - a.lavaggi.filter(l => l.t > last.t && l.stato !== 'annullato' && l.prog !== 'PROVA').length);
}
function sinceRefill(a, tipo) {
  if (!a || !a.ricariche) return null;
  const last = a.ricariche.filter(r => r.tipo === tipo).reduce((m, r) => Math.max(m, r.t), 0);
  if (!last) return null;
  return a.lavaggi.filter(l => l.t > last && l.stato !== 'annullato' && l.prog !== 'PROVA').length;
}
function slotId(handlerInput) {
  const slot = Alexa.getSlot(handlerInput.requestEnvelope, 'programma');
  const rpa = slot && slot.resolutions && slot.resolutions.resolutionsPerAuthority;
  if (rpa && rpa[0] && rpa[0].status.code === 'ER_SUCCESS_MATCH') return rpa[0].values[0].value.id;
  return null;
}
const DOMANDA = 'Quale programma? Misti, Eco, Intensivo, Push and Go oppure Fast and Clean?';

// ---------- intent ----------
const LaunchHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest',
  async handle(h) {
    const cur = await currentCycle().catch(() => null);
    if (cur && cur.end > Date.now()) {
      return h.responseBuilder.speak(`La lavastoviglie sta andando, finisce ${oraVoce(cur.end)}. Vuoi sapere altro?`).reprompt('Puoi chiedermi quanto manca, o di annullare.').getResponse();
    }
    return h.responseBuilder.speak(`Ciao! ${DOMANDA}`).reprompt(DOMANDA).getResponse();
  }
};

// Comandi "a prova di lavatrice": nessuna parola da elettrodomestico, così Alexa+ non si confonde
const GIRI = { GiroForteIntent: 'int', GiroNormaleIntent: 'misti', GiroVeloceIntent: 'fast', GiroLentoIntent: 'eco', GiroQuotidianoIntent: 'push' };

const AvviaHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    (Alexa.getIntentName(h.requestEnvelope) === 'AvviaIntent' || GIRI[Alexa.getIntentName(h.requestEnvelope)]),
  async handle(h) {
    const key = GIRI[Alexa.getIntentName(h.requestEnvelope)] || slotId(h);
    if (!key) return h.responseBuilder.speak(DOMANDA).reprompt(DOMANDA).getResponse();

    const [cur, archive] = await Promise.all([currentCycle().catch(() => null), sheet({ action: 'read' })]);
    if (cur && cur.end > Date.now()) {
      return h.responseBuilder.speak(`C'è già un lavaggio in corso che finisce ${oraVoce(cur.end)}. Se vuoi, prima dimmi di annullarlo.`).reprompt('Vuoi annullarlo?').getResponse();
    }

    const p = PROGS[key];
    const start = Date.now();
    const endSec = Math.round((start + durOf(key, archive) * 60000) / 1000);
    const seq = `lava-${key}-${endSec}`;
    const msg = `Lavastoviglie pronta da svuotare (programma ${p.n} ${p.t}, avviato alle ${oraTesto(start)})`;
    const r = await request(`${NTFY}/${TOPIC}/${seq}?${qs({ title: `🍽️ ${p.n} ${p.t} finito!`, delay: String(endSec), priority: '4', tags: 'tada' })}`, 'POST', msg).catch(() => null);
    if (!r || r.status >= 300) return h.responseBuilder.speak('Mi dispiace, non riesco a programmare la notifica. Riprova tra poco.').getResponse();

    await Promise.all([
      publishState({ a: 'start', k: key, start, end: endSec * 1000, seq }),
      sheetFire({ action: 'start', seq, start, prog: p.n, temp: p.t, min: p.m, kwh: p.kwh, litri: p.litri })
    ]);
    // conteggi calcolati sui dati letti prima, aggiungendo questo lavaggio
    const a = archive && Object.assign({}, archive, { lavaggi: archive.lavaggi.concat([{ t: start, prog: p.n, stato: 'avviato' }]) });

    let extra = '';
    if (!p.test && a) {
      const left = pillsLeft(a);
      if (left !== null && left <= (a.soglia || 5)) {
        extra += left === 0 ? ' Attenzione: le pastiglie sono finite!' : ` Attenzione: restano solo ${left} pastiglie.`;
        await notify('💊 Pastiglie quasi finite', left === 0 ? 'Pastiglie finite: da ricomprare!' : `Restano solo ${left} pastiglie: mettile nella lista della spesa 🛒`, 'shopping_cart');
      }
      const due = [];
      const nb = sinceRefill(a, 'brillantante'), ns = sinceRefill(a, 'sale');
      if (nb !== null && nb >= a.ogniBrillantante) due.push('il brillantante');
      if (ns !== null && ns >= a.ogniSale) due.push('il sale');
      if (due.length) {
        extra += ` Ricordati di controllare ${due.join(' e ')}.`;
        await notify('🧂 Controlla la lavastoviglie', `È ora di controllare ${due.join(' e ')}. Quando ricarichi, tocca "Ricaricato" nell'app.`, 'salt');
      }
    }
    return h.responseBuilder.speak(`Fatto! ${p.voce} avviato. Finisce ${oraVoce(endSec * 1000)}, vi mando la notifica.${extra}`).getResponse();
  }
};

const QuantoMancaHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'QuantoMancaIntent',
  async handle(h) {
    const cur = await currentCycle().catch(() => null);
    if (!cur) return h.responseBuilder.speak('Non c\'è nessun lavaggio in corso.').getResponse();
    const left = Math.ceil((cur.end - Date.now()) / 60000);
    if (left <= 0) return h.responseBuilder.speak(`Ha già finito, ${oraVoce(cur.end)}. Si può svuotare!`).getResponse();
    return h.responseBuilder.speak(`Mancano ${durataVoce(left)}. Finisce ${oraVoce(cur.end)}.`).getResponse();
  }
};

const AnnullaHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AnnullaLavaggioIntent',
  async handle(h) {
    const cur = await currentCycle().catch(() => null);
    if (!cur || cur.end <= Date.now()) return h.responseBuilder.speak('Non c\'è nessun lavaggio in corso da annullare.').getResponse();
    await Promise.all([
      request(`${NTFY}/${TOPIC}/${cur.seq}/delete`).catch(() => {}),
      publishState({ a: 'cancel', seq: cur.seq }),
      sheetFire({ action: 'cancel', seq: cur.seq })
    ]);
    return h.responseBuilder.speak('Ok, lavaggio annullato. Nessuna notifica partirà.').getResponse();
  }
};

const PastiglieHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'PastiglieIntent',
  async handle(h) {
    const a = await sheet({ action: 'read' });
    const left = pillsLeft(a);
    if (left === null) return h.responseBuilder.speak('Non so ancora quante pastiglie ci sono: segnalo dall\'app con Correggi o Scatolo nuovo.').getResponse();
    return h.responseBuilder.speak(left === 0 ? 'Le pastiglie sono finite!' : left === 1 ? 'Resta una sola pastiglia.' : `Restano ${left} pastiglie.`).getResponse();
  }
};

const HelpHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent',
  handle: h => h.responseBuilder.speak('Puoi dirmi: avvia il Misti, quanto manca, annulla il lavaggio, oppure quante pastiglie restano.').reprompt('Cosa vuoi fare?').getResponse()
};
const StopHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    ['AMAZON.CancelIntent', 'AMAZON.StopIntent', 'AMAZON.NoIntent'].includes(Alexa.getIntentName(h.requestEnvelope)),
  handle: h => h.responseBuilder.speak('Ok, ciao!').getResponse()
};
const FallbackHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent',
  handle: h => h.responseBuilder.speak(`Non ho capito. ${DOMANDA}`).reprompt(DOMANDA).getResponse()
};
const SessionEndedHandler = {
  canHandle: h => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
  handle: h => h.responseBuilder.getResponse()
};
const ErrorHandler = {
  canHandle: () => true,
  handle(h, error) {
    console.log('Errore:', error && error.stack);
    return h.responseBuilder.speak('Ops, qualcosa è andato storto. Riprova tra poco.').getResponse();
  }
};

const skillHandler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(LaunchHandler, AvviaHandler, QuantoMancaHandler, AnnullaHandler, PastiglieHandler,
    HelpHandler, StopHandler, FallbackHandler, SessionEndedHandler)
  .addErrorHandlers(ErrorHandler)
  .lambda();

exports.handler = (event, context, callback) => {
  context.callbackWaitsForEmptyEventLoop = false;   // risponde subito, senza aspettare Google
  return skillHandler(event, context, callback);
};
