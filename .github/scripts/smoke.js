// Smoke test de la app publicada.
//
//   node .github/scripts/smoke.js
//
// No reemplaza a una suite de tests, pero cubre la clase de error que este
// archivo produce con más frecuencia: identificadores usados antes de
// declararse, y funciones que dejan de existir tras un refactor. Ambos son
// invisibles hasta que alguien abre la pestaña afectada.

const { chromium } = require('playwright');

const USD_LABEL = { bop: 'Bopreales', bon: 'Bonares', glo: 'Globales' };
const APP = process.env.APP_URL || 'https://santosechezarreta5.github.io/bonos-ar/';

let ok = 0, bad = 0;
const check = (cond, label, detalle = '') => {
  if (cond) { ok++;  console.log(`  \x1b[32mOK\x1b[0m    ${label}`); }
  else      { bad++; console.log(`  \x1b[31mFALLA\x1b[0m ${label}${detalle ? '  → ' + detalle : ''}`); }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  const errores = [];
  const req404 = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) req404.push(`${r.status()} ${r.url().slice(0, 120)}`); });

  console.log(`\nSmoke test — ${APP}\n`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined', null, { timeout: 60000 });
  await page.waitForTimeout(20000);   // carga de precios

  // ── Utilidades base ────────────────────────────────────────────────────────
  console.log('Fechas y días hábiles');
  const u = await page.evaluate(() => ({
    hoy: hoyAR(),
    fmt: fmtDate(parseDate('2026-03-01')),
    sab: esHabil(parseDate('2026-09-05')),
    lun: esHabil(parseDate('2026-09-07')),
    mercado: typeof mercadoActivo === 'function',
  }));
  check(/^\d{4}-\d{2}-\d{2}$/.test(u.hoy), 'hoyAR() con formato válido', u.hoy);
  check(u.fmt === '2026-03-01', 'fmtDate hace round-trip', u.fmt);
  check(u.sab === false, 'sábado no es hábil');
  check(u.lun === true, 'lunes sí es hábil');
  check(u.mercado, 'mercadoActivo() existe');

  // ── Precios ────────────────────────────────────────────────────────────────
  console.log('\nCarga de precios');
  const px = await page.evaluate(() => ({
    ars: (typeof LECAPS !== 'undefined' ? LECAPS : []).filter(b => b.precio != null).length,
    arsTot: (typeof LECAPS !== 'undefined' ? LECAPS : []).length,
    usd: ['BOP_BONDS', 'BON_BONDS', 'GLO_BONDS']
      .flatMap(n => (typeof window[n] !== 'undefined' ? window[n] : eval(n)) || [])
      .filter(b => b.lastPrecio != null).length,
    api: typeof USD_PRICE_API === 'string' ? USD_PRICE_API : String(USD_PRICE_API),
  }));
  check(px.api.startsWith('https://'), 'USD_PRICE_API definido al arrancar', px.api);
  check(px.ars > 0, `LECAPS con precio: ${px.ars}/${px.arsTot}`);
  check(px.usd > 0, `bonos USD con precio: ${px.usd}`);

  // ── Familias USD (lo que toca el refactor FE-6) ─────────────────────────────
  console.log('\nFamilias USD: descriptor y envoltorios');
  const fam = await page.evaluate(() => {
    const r = {};
    for (const id of ['bop', 'bon', 'glo']) {
      const f = USD_FAM[id];
      r[id] = {
        bonds: Array.isArray(f.bonds) ? f.bonds.length : -1,
        id: f.id,
        sortCol: f.sortCol,
        tieneFns: ['save', 'chartRender', 'renderSummary', 'renderRows', 'dRenderFlows', 'dSaveEdits']
          .every(k => typeof f[k] === 'function'),
      };
    }
    // los nombres viejos siguen existiendo
    r.wrappers = ['SortBy', 'RenderSummaryRows', 'RenderSummary', 'DeleteDirect',
                  'DToggleEdit', 'DCancelEdit', 'Select', 'DSaveEdits',
                  'ShowDetail', 'ChartRender', 'DRenderFlows', 'DCalc', 'DPreviewRow']
      .flatMap(s => ['bop', 'bon', 'glo'].map(p => p + s))
      .filter(n => typeof window[n] !== 'function');
    return r;
  });
  for (const id of ['bop', 'bon', 'glo']) {
    check(fam[id].id === id, `USD_FAM.${id}.id correcto`);
    check(fam[id].bonds > 0, `USD_FAM.${id}.bonds lee la lista real`, `${fam[id].bonds} bonos`);
    check(fam[id].tieneFns, `USD_FAM.${id} tiene todas las funciones`);
  }
  check(fam.wrappers.length === 0, 'los 39 nombres originales siguen existiendo',
        fam.wrappers.length ? 'faltan: ' + fam.wrappers.join(', ') : '');

  // ── Navegación por pestañas ────────────────────────────────────────────────
  console.log('\nPestañas USD: renderizado');
  await page.evaluate(() => switchSection('usd'));
  for (const [tab, tbody] of [
    ['usd-bopreales', 'bop-summary-tbody'],
    ['usd-bonares',   'bon-summary-tbody'],
    ['usd-globales',  'glo-summary-tbody'],
  ]) {
    await page.evaluate(t => switchUsdTab(t), tab);
    await page.waitForTimeout(1200);
    const filas = await page.evaluate(id => {
      const el = document.getElementById(id);
      return el ? el.querySelectorAll('tr').length : -1;
    }, tbody);
    check(filas > 0, `${tab} renderiza filas`, `${filas} filas`);
  }

  // ── Ordenamiento (usdFamSortBy sobre el estado real) ───────────────────────
  console.log('\nOrdenamiento');
  const sort = await page.evaluate(() => {
    const antes = { col: bopSortCol, asc: bopSortAsc };
    bopSortBy('tir');
    const tras1 = { col: bopSortCol, asc: bopSortAsc };
    bopSortBy('tir');
    const tras2 = { col: bopSortCol, asc: bopSortAsc };
    return { antes, tras1, tras2, filas: document.getElementById('bop-summary-tbody').querySelectorAll('tr').length };
  });
  check(sort.tras1.col === 'tir', 'bopSortBy cambia la columna', sort.tras1.col);
  check(sort.tras1.asc !== sort.tras2.asc, 'repetir la columna invierte el sentido');
  check(sort.filas > 0, 'la tabla sigue con filas tras ordenar', `${sort.filas}`);

  // ── Selección y panel de detalle (usdFamSelect) ────────────────────────────
  console.log('\nSelección de bono y panel de detalle');
  for (const [tab, fam] of [['usd-bopreales', 'bop'], ['usd-bonares', 'bon'], ['usd-globales', 'glo']]) {
    await page.evaluate(t => switchUsdTab(t), tab);
    await page.waitForTimeout(800);
    const r = await page.evaluate(id => {
      const f = USD_FAM[id];
      const t = f.bonds[0] && f.bonds[0].ticker;
      if (!t) return { err: 'sin bonos' };
      window[id + 'Select'](t);
      const det = document.getElementById(id + '-view-detail');
      const nombre = document.getElementById(id + '-detail-name');
      const flujos = document.getElementById(id + '-d-flows') || document.getElementById(id + '-ff-body');
      return {
        ticker: t,
        sel: f.sel,
        flows: Array.isArray(f.flows) ? f.flows.length : -1,
        visible: det ? det.style.display : null,
        nombre: nombre ? nombre.textContent : null,
      };
    }, fam);
    if (r.err) { check(false, `${fam}Select`, r.err); continue; }
    check(r.sel === r.ticker, `${fam}Select fija la selección`, `${r.sel} vs ${r.ticker}`);
    check(r.flows > 0, `${fam}Select genera los flujos`, `${r.flows} flujos`);
    check(r.visible === 'flex', `${fam} abre el panel de detalle`, String(r.visible));
    check(r.nombre === r.ticker, `${fam} muestra el ticker en el panel`, `${r.nombre}`);
  }

  // ── Gráfico, flujos y cálculo ──────────────────────────────────────────────
  console.log('\nGráfico de curva, flujos y cálculo');
  for (const fam of ['bop', 'bon', 'glo']) {
    await page.evaluate(t => switchUsdTab(t), 'usd-' + ({bop:'bopreales',bon:'bonares',glo:'globales'})[fam]);
    await page.waitForTimeout(900);
    const r = await page.evaluate(id => {
      const f = USD_FAM[id];
      const t = f.bonds[0] && f.bonds[0].ticker;
      if (!t) return { err: 'sin bonos' };
      window[id + 'Select'](t);
      window[id + 'DCalc']();
      const tb = document.getElementById(id + '-d-tbody');
      const info = document.getElementById(id + '-d-flows-info');
      const dur = document.getElementById(id + '-d-dur');
      const btn = document.getElementById(id + '-d-edit-btn');
      return {
        chart: !!f.chart,
        etiqueta: f.chart && f.chart.data.datasets[0] ? f.chart.data.datasets[0].label : null,
        filas: tb ? tb.querySelectorAll('tr').length : -1,
        info: info ? info.textContent.slice(0, 40) : '',
        dur: dur ? dur.textContent : '',
        handler: btn ? btn.getAttribute('onclick') : null,
      };
    }, fam);
    if (r.err) { check(false, fam + ' gráfico/flujos', r.err); continue; }
    check(r.chart, fam + ' crea la instancia del gráfico');
    check(r.etiqueta === USD_LABEL[fam], fam + ' usa su propia etiqueta', String(r.etiqueta));
    check(r.filas > 0, fam + ' renderiza el flujo de fondos', r.filas + ' filas');
    check(/Precio:/.test(r.info), fam + 'DCalc escribe precio y paridad', r.info);
    check(/MD /.test(r.dur), fam + 'DCalc escribe la duration', r.dur);
    check(r.handler === fam + 'DToggleEdit()', fam + ' genera su propio onclick', String(r.handler));
  }

  // ── Resto de pestañas ──────────────────────────────────────────────────────
  console.log('\nResto de pestañas (no deben lanzar)');
  const antes = errores.length;
  for (const t of ['usd-resumen', 'usd-forwards', 'usd-equiv', 'usd-curvas']) {
    await page.evaluate(x => switchUsdTab(x), t);
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => switchSection('pesos'));
  for (const t of ['lecap', 'cer', 'tamar', 'dlk', 'breakeven', 'calendario', 'curvas-ars']) {
    await page.evaluate(x => switchTab(x), t);
    await page.waitForTimeout(700);
  }
  check(errores.length === antes, 'ninguna pestaña lanzó errores',
        errores.slice(antes).slice(0, 3).join(' | '));

  // ── Higiene ────────────────────────────────────────────────────────────────
  console.log('\nHigiene');
  const undef = req404.filter(r => r.includes('/undefined'));
  check(undef.length === 0, 'sin peticiones a /undefined', undef.join(', '));
  const graves = errores.filter(e => /is not defined|is not a function|before initialization|Cannot read/.test(e));
  check(graves.length === 0, 'sin ReferenceError/TypeError', graves.slice(0, 3).join(' | '));

  if (req404.length) {
    console.log('\n  peticiones con status >= 400:');
    for (const r of [...new Set(req404)].slice(0, 8)) console.log('    ' + r);
  }

  console.log(`\n${ok} OK · ${bad} fallas\n`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
