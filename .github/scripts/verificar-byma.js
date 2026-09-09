// Verifica las definiciones de bonos de la app contra la ficha técnica oficial
// de BYMA.
//
//   node .github/scripts/verificar-byma.js
//   APP_URL=http://localhost:8000/ node .github/scripts/verificar-byma.js
//
// Por qué en un navegador headless y no en Node puro: el residual tiene que
// salir de las MISMAS funciones que usa la calculadora — bopGenFlows y
// bopGetOutstanding para los bonos en dólares, cerCouponDates y
// cerBuildAmortTable para los CER. Reimplementar esa lógica acá compararía mi
// reimplementación contra BYMA, no la app contra BYMA, que es lo que interesa.
//
// El residual es la verificación fuerte: sale del cronograma de amortización
// completo, así que un solo número valida todas las cuotas de golpe. Si una
// cuota tiene mal la fecha o el porcentaje, no cierra.
//
// No corre en cada push: son ~80 pedidos a una API pública que pide no más de
// uno por segundo. Va semanal, y a mano cuando haga falta.

const { chromium } = require('playwright');

const APP = process.env.APP_URL || 'https://santosechezarreta5.github.io/bonos-ar/';
const BYMA = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free'
           + '/bnown/fichatecnica/especies/general';
const PAUSA_MS = 1100;   // BYMA pide no más de 1 req/s
const TOL_RESIDUAL = 0.6; // BYMA redondea el monto residual

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Ley esperada según la familia. Es lo que sostiene el spread de legislación:
// si un Global dejara de ser ley extranjera, el par Global/Bonar no significa nada.
const LEY_ESPERADA = {
  GLO: 'extranjera',      // Nueva York / Inglaterra / Extranjera
  BON: 'nacional',
  BOP: 'nacional',
};

async function fichaByma(ticker) {
  const res = await fetch(BYMA, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ symbol: ticker }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const d = (j.data || [])[0];
  return d || null;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  console.log(`\nVerificación contra BYMA — ${APP}\n`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined', null, { timeout: 60000 });

  // Se esperan las DEFINICIONES, no los precios: este chequeo no necesita
  // cotizaciones y así no queda atado a que data912 esté en pie.
  await page.waitForFunction(() => {
    const usd = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length > 0;
    const ars = typeof CER_BONDS !== 'undefined' && CER_BONDS.length > 0;
    return usd && ars;
  }, null, { timeout: 90000 });

  const bonos = await page.evaluate(() => {
    const liqRaw = G_LIQ || addHabiles(TODAY, 1);
    const liqStr = liqRaw instanceof Date ? fmtDate(liqRaw) : String(liqRaw);
    const liqD = parseDate(liqStr);
    const out = [];

    // ── USD: el residual sale de las funciones de la calculadora ──────────────
    for (const [arr, sector] of [[BOP_BONDS, 'BOP'], [BON_BONDS, 'BON'], [GLO_BONDS, 'GLO']]) {
      for (const b of arr || []) {
        let residual = null, err = null;
        try { residual = bopGetOutstanding(bopGenFlows(b), liqD); }
        catch (e) { err = e.message; }
        out.push({ ticker: b.ticker, sector, emision: b.emision,
                   vencimiento: b.vencimiento, residual, err, moneda: 'Dólares' });
      }
    }

    // ── TF: LECAP y BONCAP son bullet, el residual es 100 por construcción ────
    for (const b of (typeof LECAPS !== 'undefined' ? LECAPS : [])) {
      out.push({ ticker: b.ticker, sector: 'TF', emision: b.emision,
                 vencimiento: b.vcto, residual: 100, moneda: 'Pesos' });
    }

    // ── CER: se repite el paso 1 de cerBuildFlujos con sus mismas funciones ───
    for (const b of (typeof CER_BONDS !== 'undefined' ? CER_BONDS : [])) {
      let residual = null, err = null;
      try {
        if (b.tipo === 'lecer') {
          residual = 100;
        } else {
          const freq = b.freq || 6;
          const dates = cerCouponDates(b.emision, b.vcto, freq, b.primerCupon || null);
          const tabla = cerBuildAmortTable(b, dates, freq);
          if (b.cuponSchedule && b.cuponSchedule.length) {
            // Con PIK el capital crece antes de amortizar (caso DICP)
            const mapa = new Map(tabla.map(a => [a.fecha, a.pct]));
            let vn = 100;
            for (const d of dates) {
              if (d > liqD) break;
              const tramo = b.cuponSchedule.find(t =>
                d > parseDate(t.desde) && d <= parseDate(t.hasta));
              const pik = ((tramo && tramo.tasaPIK) || 0) / 100 * (freq / 12);
              vn = Math.max(0, vn * (1 + pik) - (mapa.get(fmtDate(d)) || 0));
            }
            residual = vn;
          } else {
            let vn = b.vnInicial || 100;
            tabla.forEach(a => { if (parseDate(a.fecha) <= liqD) vn = Math.max(0, vn - a.pct); });
            residual = vn;
          }
        }
      } catch (e) { err = e.message; }
      out.push({ ticker: b.ticker, sector: 'CER', emision: b.emision,
                 vencimiento: b.vcto, residual, err, moneda: 'Pesos' });
    }

    // ── TAMAR: la definición no contempla amortización, así que 100 ───────────
    for (const b of (typeof TAMAR_BONDS !== 'undefined' ? TAMAR_BONDS : [])) {
      out.push({ ticker: b.ticker, sector: 'TAMAR', emision: b.emision,
                 vencimiento: b.vcto, residual: 100, moneda: 'Pesos' });
    }

    // ── DLK: residual sin verificar a propósito, ver el comentario del informe ─
    for (const b of (typeof DLK_BONDS !== 'undefined' ? DLK_BONDS : [])) {
      out.push({ ticker: b.ticker, sector: 'DLK', emision: b.emision,
                 vencimiento: b.vcto, residual: null, moneda: 'Pesos' });
    }

    return out;
  });

  await browser.close();

  console.log(`${bonos.length} bonos definidos en la app. Consultando BYMA…\n`);

  const duras = [];    // definición contra la fuente oficial: hay que mirarlo
  const avisos = [];   // puede tener explicación legítima
  const sinFicha = [];
  let okCount = 0;

  for (const b of bonos) {
    let f;
    try { f = await fichaByma(b.ticker); }
    catch (e) { sinFicha.push(`${b.ticker}: ${e.message}`); await dormir(PAUSA_MS); continue; }
    await dormir(PAUSA_MS);

    if (!f) { sinFicha.push(`${b.ticker}: BYMA no tiene ficha`); continue; }

    const id = `${b.ticker} (${b.sector})`;
    const bEm = (f.fechaEmision || '').slice(0, 10);
    const bVc = (f.fechaVencimiento || '').slice(0, 10);
    let limpio = true;

    if (bVc && b.vencimiento && bVc !== b.vencimiento) {
      duras.push(`${id} vencimiento: app ${b.vencimiento} · BYMA ${bVc}`);
      limpio = false;
    }
    // La fecha de emisión de un reestructurado puede diferir de la del canje, así
    // que se informa pero no se cuenta como error de definición.
    if (bEm && b.emision && bEm !== b.emision) {
      avisos.push(`${id} emisión: app ${b.emision} · BYMA ${bEm}`);
      limpio = false;
    }

    const bMon = (f.moneda || '').toLowerCase();
    if (bMon && b.moneda && !bMon.startsWith(b.moneda.slice(0, 4).toLowerCase())) {
      duras.push(`${id} moneda: app ${b.moneda} · BYMA ${f.moneda}`);
      limpio = false;
    }

    const leyEsp = LEY_ESPERADA[b.sector];
    if (leyEsp && f.ley) {
      const esNacional = /nacional/i.test(f.ley);
      const esperadaNacional = leyEsp === 'nacional';
      if (esNacional !== esperadaNacional) {
        duras.push(`${id} ley: se esperaba ${leyEsp} · BYMA dice "${f.ley}"`);
        limpio = false;
      }
    }

    if (b.err) {
      avisos.push(`${id} la app no pudo calcular el residual: ${b.err}`);
      limpio = false;
    } else if (b.residual != null && f.montoNominal > 0 && f.montoResidual != null) {
      const bRes = 100 * f.montoResidual / f.montoNominal;
      const d = Math.abs(bRes - b.residual);
      if (d > TOL_RESIDUAL) {
        // Puede ser recompra del Tesoro, que baja el residual sin que el
        // cronograma de la app esté mal. Por eso es aviso y no error.
        avisos.push(`${id} residual: app ${b.residual.toFixed(2)}% · BYMA ${bRes.toFixed(2)}%`
                  + `  (dif ${d.toFixed(2)} pp)`);
        limpio = false;
      }
    } else if (b.residual == null) {
      avisos.push(`${id} residual sin verificar (la app no lo expone para este sector)`);
      limpio = false;
    }

    if (limpio) { okCount++; console.log(`  \x1b[32mOK\x1b[0m    ${id}`); }
  }

  const bloque = (titulo, arr, color) => {
    if (!arr.length) return;
    console.log(`\n${titulo} (${arr.length})`);
    for (const l of arr) console.log(`  \x1b[${color}m·\x1b[0m ${l}`);
  };
  bloque('Discrepancias con la fuente oficial', duras, '31');
  bloque('Avisos', avisos, '33');
  bloque('Sin ficha en BYMA', sinFicha, '90');

  console.log(`\n${okCount} sin observaciones · ${duras.length} discrepancias · `
            + `${avisos.length} avisos · ${sinFicha.length} sin ficha\n`);

  process.exit(duras.length ? 1 : 0);
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
