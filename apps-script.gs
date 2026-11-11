// Archivio Lavastoviglie - collega la web app al Google Foglio "Lavastoviglie - Archivio"
// Va pubblicato come App web: Esegui come "Me", Accesso "Chiunque".

const SHEET_ID = '1P-RsyFU-QjZpJEBJfpH_RfMPO0l7K1uO4GaTMULnI4E';

function doGet(e) {
  const p = (e && e.parameter) || {};
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const lav = ss.getSheetByName('Lavaggi');
    const pas = ss.getSheetByName('Pastiglie');

    if (p.action === 'start' && p.seq) {
      if (colValues_(lav, 8).indexOf(p.seq) < 0) {
        const r = lastRow_(lav) + 1;
        lav.getRange(r, 1, 1, 8).setValues([[
          new Date(Number(p.start)), p.prog, p.temp, Number(p.min),
          Number(p.kwh), Number(p.litri), 'avviato', p.seq
        ]]);
      }
    } else if (p.action === 'cancel' && p.seq) {
      const i = colValues_(lav, 8).indexOf(p.seq);
      if (i >= 0) lav.getRange(i + 2, 7).setValue('annullato');
    } else if (p.action === 'box' && p.qty !== undefined) {
      const r = lastRow_(pas) + 1;
      pas.getRange(r, 1, 1, 3).setValues([[
        new Date(), p.tipo === 'correzione' ? 'Correzione' : 'Scatolo nuovo', Number(p.qty)
      ]]);
    }
    SpreadsheetApp.flush();
    return json_(readAll_(ss));
  } finally {
    lock.releaseLock();
  }
}

// Ultima riga con una data in colonna A (1 = solo intestazione)
function lastRow_(sh) {
  const v = sh.getRange('A2:A').getValues();
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i][0] !== '') n = i + 1;
  return n + 1;
}

function colValues_(sh, col) {
  const last = lastRow_(sh);
  if (last < 2) return [];
  return sh.getRange(2, col, last - 1, 1).getValues().map(r => String(r[0]));
}

function readAll_(ss) {
  const lav = ss.getSheetByName('Lavaggi');
  const pas = ss.getSheetByName('Pastiglie');
  const imp = ss.getSheetByName('Impostazioni');
  const ms = d => (d instanceof Date ? d.getTime() : null);

  const lr = lastRow_(lav), pr = lastRow_(pas);
  const lavaggi = lr < 2 ? [] : lav.getRange(2, 1, lr - 1, 8).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ t: ms(r[0]), prog: r[1], temp: r[2], min: r[3], kwh: r[4], litri: r[5], stato: r[6], seq: String(r[7]) }));
  const pastiglie = pr < 2 ? [] : pas.getRange(2, 1, pr - 1, 3).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ t: ms(r[0]), evento: r[1], qty: r[2] }));
  const s = imp.getRange('B2:B4').getValues();

  return { ok: true, lavaggi, pastiglie, prezzo: Number(s[0][0]) || 0, perScatolo: Number(s[1][0]) || 88, soglia: Number(s[2][0]) || 5 };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
