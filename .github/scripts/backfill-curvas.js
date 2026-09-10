// Backfill del histórico de curvas: reconstruye bond_price_snapshots para
// fechas pasadas a partir de los cierres de BYMA.
//
//   DESDE=2025-01-01 node .github/scripts/backfill-curvas.js
//   DRY_RUN=1 node .github/scripts/backfill-curvas.js        (no escribe nada)
//
// Igual que snapshot.js, corre la app real en un navegador headless y usa SU
// código de valuación. Acá importa todavía más: si reimplementara la TIR en
// Node, el histórico reconstruido no sería comparable con lo que la app calcula
// en vivo, y las curvas mezclarían dos matemáticas distintas.
//
// Para valuar en una fecha pasada alcanza con mover G_LIQ. TODAY es const, pero
// no participa de la matemática de precios: todas las funciones toman la
// liquidación de `G_LIQ || addHabiles(TODAY,1)`. Los índices CER, TAMAR y A3500
// ya vienen con su historia completa desde el BCRA, así que la valuación de una
// rueda de 2025 usa el índice de esa rueda y no el de hoy.
//
// Fuente de precios: BYMA, no data912. El histórico de data912 sólo cubre bonos
// viejos (DICP, TX26, GD30) y no tiene LECAPs, TAMAR, DLK ni Bopreales. BYMA
// tiene todo desde septiembre de 2024, que alcanza de sobra para 2025 y 2026.
//
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');

const APP_URL  = 'https://santosechezarreta5.github.io/bonos-ar/';
const EMAIL    = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;
const DESDE    = process.env.DESDE || '2025-01-01';
const HASTA    = process.env.HASTA ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const DRY      = process.env.DRY_RUN === '1';
const SOBRESCRIBIR = process.env.SOBRESCRIBIR === '1';

const BYMA_HIST = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free'
                + '/chart/historical-series/history';
const PAUSA_MS = 1100;   // BYMA pide no más de 1 req/s
const LOTE     = 500;    // filas por upsert

const dormir = ms => new Promise(r => setTimeout(r, ms));
const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

// Serie diaria de cierres. Los timestamps caen siempre en día hábil leyéndolos
// en UTC — verificado contra GD30D: 410 ruedas, ningún sábado ni domingo.
async function serieByma(symbol) {
  const from = Math.floor(Date.parse(DESDE + 'T00:00:00Z') / 1000) - 86400 * 5;
  const to   = Math.floor(Date.parse(HASTA + 'T00:00:00Z') / 1000) + 86400 * 2;
  const url  = `${BYMA_HIST}?symbol=${encodeURIComponent(symbol + ' 24HS')}`
             + `&resolution=D&from=${from}&to=${to}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d.s !== 'ok' || !Array.isArray(d.t)) return [];
  const out = [];
  for (let i = 0; i < d.t.length; i++) {
    const c = d.c[i];
    if (!(c > 0)) continue;
    const fecha = new Date(d.t[i] * 1000).toISOString().slice(0, 10);
    if (fecha >= DESDE && fecha <= HASTA) out.push({ fecha, cierre: c });
  }
  return out;
}

(async () => {
  if (!EMAIL || !PASSWORD) fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.log(`\nBackfill de curvas — ${DESDE} a ${HASTA}${DRY ? '  (DRY RUN)' : ''}\n`);

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined' && supa.auth, null, { timeout: 60000 });

  const login = await page.evaluate(async ([email, password]) => {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    return error ? { ok: false, error: error.message } : { ok: true, uid: data.user.id };
  }, [EMAIL, PASSWORD]);
  if (!login.ok) fatal(`Login rechazado: ${login.error}`);
  console.log(`→ autenticado (uid ${login.uid.slice(0, 8)}…)`);

  // Definiciones y los índices que necesita la valuación histórica.
  console.log('→ esperando definiciones e índices…');
  await page.evaluate(async () => {
    if (typeof cerFetchIndex === 'function' && !CER_INDEX.length) await cerFetchIndex();
    if (typeof tamarFetchIndex === 'function' && !TAMAR_INDEX.length) await tamarFetchIndex();
    if (typeof dlkFetchIndex === 'function' && !DLK_INDEX.length) await dlkFetchIndex();
  });
  await page.waitForFunction(() => {
    const defs = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length > 0 && CER_BONDS.length > 0;
    return defs && CER_INDEX.length > 0 && TAMAR_INDEX.length > 0 && DLK_INDEX.length > 0;
  }, null, { timeout: 120000 });

  // Qué símbolo de BYMA le corresponde a cada bono. Para los que cotizan en
  // dólares es el símbolo MEP de la tabla de equivalencias de la app, la misma
  // que usa para pedir precios en vivo — no se adivina el sufijo.
  const objetivo = await page.evaluate(() => {
    const eq = new Map((typeof EQUIV_DATA !== 'undefined' ? EQUIV_DATA : [])
      .map(e => [e.ticker, e.mep || e.cable]));
    const out = [];
    for (const [arr, sector] of [[BOP_BONDS, 'BOP'], [BON_BONDS, 'BON'], [GLO_BONDS, 'GLO']])
      for (const b of arr || []) out.push({ ticker: b.ticker, sector, symbol: eq.get(b.ticker) || null });
    for (const [arr, sector] of [
      [typeof LECAPS      !== 'undefined' ? LECAPS      : [], 'TF'],
      [typeof CER_BONDS   !== 'undefined' ? CER_BONDS   : [], 'CER'],
      [typeof TAMAR_BONDS !== 'undefined' ? TAMAR_BONDS : [], 'TAMAR'],
      [typeof DLK_BONDS   !== 'undefined' ? DLK_BONDS   : [], 'DLK'],
    ]) for (const b of arr || []) out.push({ ticker: b.ticker, sector, symbol: b.ticker });
    // Un mismo ticker puede estar en dos sectores (TXMJ0 en CER y TAMAR): el
    // precio es el mismo, así que se pide una sola vez.
    const vistos = new Set();
    return out.filter(o => o.symbol && !vistos.has(o.symbol) && vistos.add(o.symbol));
  });

  console.log(`→ ${objetivo.length} símbolos a pedir a BYMA (~${Math.round(objetivo.length * PAUSA_MS / 1000)}s)\n`);

  // precios[fecha][ticker] = cierre
  const precios = {};
  let conDatos = 0;
  const sinDatos = [];
  for (const o of objetivo) {
    let serie = [];
    try { serie = await serieByma(o.symbol); }
    catch (e) { sinDatos.push(`${o.ticker} (${o.symbol}): ${e.message}`); await dormir(PAUSA_MS); continue; }
    await dormir(PAUSA_MS);
    if (!serie.length) { sinDatos.push(`${o.ticker} (${o.symbol}): sin ruedas`); continue; }
    conDatos++;
    for (const { fecha, cierre } of serie) {
      (precios[fecha] || (precios[fecha] = {}))[o.ticker] = cierre;
    }
    process.stdout.write(`  ${o.ticker} ${serie.length}\r`);
  }
  console.log(`  ${conDatos} series traídas · ${sinDatos.length} sin datos          `);
  if (sinDatos.length) for (const s of sinDatos.slice(0, 12)) console.log(`    · ${s}`);

  let fechas = Object.keys(precios).sort();
  if (!fechas.length) fatal('BYMA no devolvió ninguna rueda en el rango.');

  // No pisar lo que ya guardó el snapshot diario, que se tomó con precios en
  // vivo. Se recorta el backfill hasta la primera fecha existente.
  if (!SOBRESCRIBIR) {
    const primera = await page.evaluate(async () => {
      const { data } = await supa.from('bond_price_snapshots')
        .select('snapshot_date').order('snapshot_date', { ascending: true }).limit(1);
      return data && data.length ? data[0].snapshot_date : null;
    });
    if (primera) {
      const antes = fechas.length;
      fechas = fechas.filter(f => f < primera);
      console.log(`→ ya hay snapshots desde ${primera}: se omiten ${antes - fechas.length} ruedas`
                + ' (SOBRESCRIBIR=1 para pisarlas)');
    }
  }
  console.log(`→ ${fechas.length} ruedas a reconstruir\n`);

  // De a un mes: acota lo que viaja al navegador y da progreso visible.
  const meses = [...new Set(fechas.map(f => f.slice(0, 7)))].sort();
  let totalFilas = 0, totalGuardadas = 0;

  for (const mes of meses) {
    const delMes = fechas.filter(f => f.startsWith(mes));
    const px = {};
    for (const f of delMes) px[f] = precios[f];

    const res = await page.evaluate(async ({ delMes, px, dry }) => {
      const bkLiq = G_LIQ, bkTC = dlkTCOverride;
      const filas = [];
      try {
        for (const fecha of delMes) {
          const p = px[fecha] || {};
          // Liquidación de esa rueda: T+1 hábil, el plazo por defecto de la app.
          G_LIQ = addHabiles(parseDate(fecha), 1);
          const liqStr = fmtDate(G_LIQ);

          // A3500 vigente en esa liquidación, para los dollar linked. Sin esto
          // dlkTCHoy() devolvería el tipo de cambio de hoy y la TNA saldría mal.
          let tc = null;
          for (const r of DLK_INDEX) if (r.fecha <= liqStr && r.valor > 0 && (!tc || r.fecha > tc.fecha)) tc = r;
          dlkTCOverride = tc ? tc.valor : null;

          for (const [arr, sector] of [[BOP_BONDS, 'BOP'], [BON_BONDS, 'BON'], [GLO_BONDS, 'GLO']])
            for (const b of arr || []) {
              const v = p[b.ticker]; if (v == null) continue;
              try {
                const r = usdResCalcRow({ ...b, lastPrecio: v }, liqStr);
                if (r.tir == null || isNaN(r.tir) || r.md == null) continue;
                filas.push({ snapshot_date: fecha, ticker: b.ticker, sector, price: +v.toFixed(4),
                             tir: +r.tir.toFixed(6), md: +r.md.toFixed(4), dias: null });
              } catch (e) {}
            }

          for (const b of (typeof LECAPS !== 'undefined' ? LECAPS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            try {
              const e = enrich({ ...b, precio: v });
              if (!e || isNaN(e.tna) || !(e.dias > 0)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'TF', price: +v.toFixed(4),
                           tir: +e.tna.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof CER_BONDS !== 'undefined' ? CER_BONDS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            try {
              const e = cerEnrich({ ...b, precio: v });
              if (!e || isNaN(e.tir) || !(e.dias > 0)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'CER', price: +v.toFixed(4),
                           tir: +e.tir.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof TAMAR_BONDS !== 'undefined' ? TAMAR_BONDS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            try {
              const e = tamarEnrich({ ...b, precio: v });
              if (!e || isNaN(e.margenTNA) || !(e.dias > 0)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'TAMAR', price: +v.toFixed(4),
                           tir: +e.margenTNA.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof DLK_BONDS !== 'undefined' ? DLK_BONDS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            try {
              const e = dlkEnrich({ ...b, precio: v });
              if (!e || e.tna == null || isNaN(e.tna) || !(e.dias > 0)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'DLK', price: +v.toFixed(4),
                           tir: +e.tna.toFixed(6),
                           md: (e.dias > 0) ? +(e.dias / 365 / (1 + e.tna / 100)).toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }
        }
      } finally { G_LIQ = bkLiq; dlkTCOverride = bkTC; }

      if (dry) return { filas: filas.length, guardadas: 0, error: null };

      // Un ticker puede vivir en dos sectores; la clave única incluye sector,
      // así que se deduplica por (fecha, ticker, sector) antes de mandar.
      const clave = r => `${r.snapshot_date}|${r.ticker}|${r.sector}`;
      const unicas = [...new Map(filas.map(r => [clave(r), r])).values()];
      let guardadas = 0;
      for (let i = 0; i < unicas.length; i += 500) {
        const lote = unicas.slice(i, i + 500);
        const { error } = await supa.from('bond_price_snapshots')
          .upsert(lote, { onConflict: 'snapshot_date,ticker,sector' });
        if (error) return { filas: filas.length, guardadas, error: error.message };
        guardadas += lote.length;
      }
      return { filas: filas.length, guardadas, error: null };
    }, { delMes, px, dry: DRY });

    totalFilas += res.filas;
    totalGuardadas += res.guardadas;
    const estado = res.error ? `\x1b[31mERROR ${res.error}\x1b[0m` : `${res.guardadas} guardadas`;
    console.log(`  ${mes}  ${delMes.length} ruedas · ${res.filas} filas · ${DRY ? 'dry run' : estado}`);
    if (res.error) { await browser.close(); fatal(`Falló el upsert en ${mes}`); }
  }

  console.log(`\n${totalFilas} filas calculadas · ${DRY ? '0 guardadas (dry run)' : totalGuardadas + ' guardadas'}\n`);
  await browser.close();
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
