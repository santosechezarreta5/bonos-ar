// Smoke test de la app publicada.
//
//   node .github/scripts/smoke.js
//
// No reemplaza a una suite de tests, pero cubre la clase de error que este
// archivo produce con más frecuencia: identificadores usados antes de
// declararse, y funciones que dejan de existir o cambian de firma tras un
// refactor. Ambos son invisibles hasta que alguien abre la pestaña afectada.
//
// Ya atajó dos: usdFamDRenderFlows con nombres de parámetro equivocados
// (ReferenceError al abrir cualquier bono USD) y onclick generados que
// apuntaban siempre a bop. Los dos pasaban node --check sin problema.

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
  const req400 = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) req400.push(`${r.status()} ${r.url().slice(0, 120)}`); });

  console.log(`\nSmoke test — ${APP}\n`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined', null, { timeout: 60000 });

  // Esperar la CONDICIÓN, no un tiempo fijo. Los precios USD dependen de que
  // supaLoadSharedData() traiga primero las equivalencias ticker → símbolo MEP,
  // y ese encadenamiento tarda distinto según de dónde se sirva la app. Con un
  // waitForTimeout el test quedaba atado a la suerte del timing.
  try {
    await page.waitForFunction(() => {
      const ars = typeof LECAPS !== 'undefined' && LECAPS.some(b => b.precio != null);
      const usd = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().some(b => b.lastPrecio != null);
      return ars && usd;
    }, null, { timeout: 90000 });
  } catch (e) {
    // Si no llegan, seguimos igual: los checks de abajo reportan qué faltó.
    const d = await page.evaluate(async () => {
      const out = {
        equiv: typeof EQUIV_DATA !== 'undefined' ? EQUIV_DATA.length : -1,
        usdBonos: [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length,
        moneda: typeof usdCurrency !== 'undefined' ? usdCurrency : '?',
        api: String(USD_PRICE_API),
        mercado: typeof mercadoActivo === 'function' ? mercadoActivo() : '?',
      };
      // Reproducir el camino real y ver dónde se corta
      try {
        const r = await usdFetchPriceMap();
        out.mapSize = Object.keys(r.map || {}).length;
        out.gd30d = r.map ? r.map['GD30D'] : undefined;
        const eq = (EQUIV_DATA || []).find(e => e.ticker === 'GD30');
        out.equivGD30 = eq ? JSON.stringify(eq) : 'no está';
      } catch (e) { out.errFetch = e.message; }
      try {
        await usdRefreshPrices();
        out.trasRefresh = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat()
          .filter(b => b.lastPrecio != null).length;
      } catch (e) { out.errRefresh = e.message; }
      return out;
    });
    console.log('  \x1b[33m(timeout esperando precios)\x1b[0m');
    for (const [k, v] of Object.entries(d)) console.log(`     ${k}: ${v}`);
  }
  await page.waitForTimeout(3000);

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

  console.log('\nCarga de precios');
  const px = await page.evaluate(() => ({
    ars: (typeof LECAPS !== 'undefined' ? LECAPS : []).filter(b => b.precio != null).length,
    arsTot: (typeof LECAPS !== 'undefined' ? LECAPS : []).length,
    usd: [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().filter(b => b.lastPrecio != null).length,
    api: String(USD_PRICE_API),
  }));
  check(px.api.startsWith('https://'), 'USD_PRICE_API definido al arrancar', px.api);
  check(px.ars > 0, `LECAPS con precio: ${px.ars}/${px.arsTot}`);
  check(px.usd > 0, `bonos USD con precio: ${px.usd}`);

  console.log('\nFamilias USD: descriptor y envoltorios');
  const fam = await page.evaluate(() => {
    const r = {};
    for (const id of ['bop', 'bon', 'glo']) {
      const f = USD_FAM[id];
      r[id] = {
        bonds: Array.isArray(f.bonds) ? f.bonds.length : -1,
        id: f.id,
        tieneFns: ['save', 'chartRender', 'renderSummary', 'renderRows',
                   'dRenderFlows', 'dSaveEdits', 'showDetail', 'dCalc', 'dPreviewRow']
          .every(k => typeof f[k] === 'function'),
      };
    }
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

  console.log('\nOrdenamiento');
  const sort = await page.evaluate(() => {
    bopSortBy('tir');
    const a = { col: bopSortCol, asc: bopSortAsc };
    bopSortBy('tir');
    const b = { col: bopSortCol, asc: bopSortAsc };
    return { a, b, filas: document.getElementById('bop-summary-tbody').querySelectorAll('tr').length };
  });
  check(sort.a.col === 'tir', 'bopSortBy cambia la columna', sort.a.col);
  check(sort.a.asc !== sort.b.asc, 'repetir la columna invierte el sentido');
  check(sort.filas > 0, 'la tabla sigue con filas tras ordenar', `${sort.filas}`);

  console.log('\nSelección, gráfico, flujos y cálculo');
  for (const id of ['bop', 'bon', 'glo']) {
    const tab = 'usd-' + ({ bop: 'bopreales', bon: 'bonares', glo: 'globales' })[id];
    await page.evaluate(t => switchUsdTab(t), tab);
    await page.waitForTimeout(900);
    const r = await page.evaluate(f => {
      const fm = USD_FAM[f];
      const t = fm.bonds[0] && fm.bonds[0].ticker;
      if (!t) return { err: 'sin bonos' };
      window[f + 'Select'](t);
      window[f + 'DCalc']();
      const tb = document.getElementById(f + '-d-tbody');
      const info = document.getElementById(f + '-d-flows-info');
      const dur = document.getElementById(f + '-d-dur');
      const btn = document.getElementById(f + '-d-edit-btn');
      const det = document.getElementById(f + '-view-detail');
      const nom = document.getElementById(f + '-detail-name');
      return {
        ticker: t, sel: fm.sel,
        flows: Array.isArray(fm.flows) ? fm.flows.length : -1,
        visible: det ? det.style.display : null,
        nombre: nom ? nom.textContent : null,
        chart: !!fm.chart,
        etiqueta: fm.chart && fm.chart.data.datasets[0] ? fm.chart.data.datasets[0].label : null,
        filas: tb ? tb.querySelectorAll('tr').length : -1,
        info: info ? info.textContent.slice(0, 40) : '',
        dur: dur ? dur.textContent : '',
        handler: btn ? btn.getAttribute('onclick') : null,
      };
    }, id);
    if (r.err) { check(false, `${id}Select`, r.err); continue; }
    check(r.sel === r.ticker, `${id}Select fija la selección`, `${r.sel}`);
    check(r.flows > 0, `${id}Select genera los flujos`, `${r.flows}`);
    check(r.visible === 'flex', `${id} abre el panel de detalle`, String(r.visible));
    check(r.nombre === r.ticker, `${id} muestra el ticker en el panel`, String(r.nombre));
    check(r.chart, `${id} crea la instancia del gráfico`);
    check(r.etiqueta === USD_LABEL[id], `${id} usa su propia etiqueta`, String(r.etiqueta));
    check(r.filas > 0, `${id} renderiza el flujo de fondos`, `${r.filas} filas`);
    check(/Precio:/.test(r.info), `${id}DCalc escribe precio y paridad`, r.info);
    check(/MD /.test(r.dur), `${id}DCalc escribe la duration`, r.dur);
    check(r.handler === `${id}DToggleEdit()`, `${id} genera su propio onclick`, String(r.handler));
  }

  console.log('\nSpread de legislación (solapa SLEG)');
  await page.evaluate(() => switchUsdTab('usd-curvas'));
  await page.waitForTimeout(1500);
  const sleg = await page.evaluate(async () => {
    curvasUsdSetSector('SLEG');
    await new Promise(r => setTimeout(r, 2500));
    const chips = document.getElementById('curvas-usd-bonds');
    const msg = document.getElementById('curvas-usd-msg');
    const pares = _curvasSpreadCache.pares || [];
    return {
      chipSLEG: !!document.getElementById('curvas-usd-chip-SLEG'),
      pares: pares.length,
      conDato: pares.filter(p => p.s1 != null || p.s2 != null).length,
      etiquetas: pares.slice(0, 3).map(p => p.label),
      chips: chips ? chips.querySelectorAll('button').length : 0,
      msg: msg ? msg.textContent : '',
      chart: !!curvasUsdChart,
      ejeY: curvasUsdChart ? curvasUsdChart.options.scales.y.title.text : '',
    };
  });
  check(sleg.chipSLEG, 'existe el chip Spread Leg.');
  check(sleg.pares > 0, 'arma pares Global/Bonar', `${sleg.pares}: ${sleg.etiquetas.join(', ')}`);
  check(sleg.conDato > 0, 'calcula spreads', `${sleg.conDato}/${sleg.pares} con dato`);
  check(sleg.chips === sleg.pares, 'un chip por par', `${sleg.chips} chips`);
  check(sleg.chart, 'dibuja el gráfico');
  check(/Spread/.test(sleg.ejeY), 'el eje Y es el spread', sleg.ejeY);

  const volver = await page.evaluate(async () => {
    curvasUsdSetSector('GLO');
    await new Promise(r => setTimeout(r, 2500));
    return curvasUsdChart ? curvasUsdChart.options.scales.y.title.text : '';
  });
  check(/TIR/.test(volver), 'volver a Globales restaura la curva de tasa', volver);

  console.log('\nPesos: tablas por tipo');
  await page.evaluate(() => switchSection('pesos'));
  for (const [tab, tbody, arr] of [
    ['lecap', 'table-body',       'DATA'],
    ['cer',   'cer-table-body',   'CER_DATA'],
    ['tamar', 'tamar-table-body', 'TAMAR_DATA'],
    ['dlk',   'dlk-table-body',   'DLK_DATA'],
  ]) {
    await page.evaluate(t => switchTab(t), tab);
    await page.waitForTimeout(1000);
    const r = await page.evaluate(([id, name]) => {
      const el = document.getElementById(id);
      const filas = el ? el.querySelectorAll('tr').length : -1;
      let datos = -1, conTasa = -1;
      try {
        const a = eval(name);
        if (Array.isArray(a)) {
          datos = a.length;
          conTasa = a.filter(x => [x.tna, x.tir, x.margenTNA]
            .some(v => v != null && !isNaN(v))).length;
        }
      } catch (e) {}
      return { filas, datos, conTasa };
    }, [tbody, arr]);
    check(r.filas > 0, `${tab} renderiza filas`, `${r.filas} filas`);
    check(r.conTasa > 0, `${tab} calcula tasas`, `${r.conTasa}/${r.datos} con tasa`);
  }

  console.log('\nIndicador del snapshot');
  const snap = await page.evaluate(async () => {
    await snapEstadoRefrescar();
    const el = document.getElementById('snap-estado');
    return el ? { txt: el.textContent, title: el.title } : null;
  });
  check(!!snap, 'el indicador existe');
  check(snap && /snapshot/.test(snap.txt), 'muestra la fecha del último snapshot', snap && snap.txt);
  check(snap && /bonos/.test(snap.title), 'el tooltip trae el detalle', snap && snap.title);

  console.log('\nSeries de tiempo');
  for (const [sec, tab, ir] of [
    ['ars', 'series-ars', 'switchTab'],
    ['usd', 'usd-series', 'switchUsdTab'],
  ]) {
    await page.evaluate(([t, fn]) => {
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
    }, [tab, ir]);
    await page.waitForTimeout(3500);

    const r = await page.evaluate(s => {
      const st = seriesEstado[s], cfg = SERIES_CFG[s];
      const chips = document.getElementById(`series-${s}-chips`);
      const d1 = document.getElementById(`series-${s}-d1`);
      const d2 = document.getElementById(`series-${s}-d2`);
      return {
        sector: st.sector,
        sectores: cfg.sectores.map(o => o.v),
        fechas: st.cache.fechas.length,
        bonos: st.cache.porBono.size,
        chips: chips ? chips.querySelectorAll('button').length : 0,
        series: st.chart ? st.chart.data.datasets.length : -1,
        ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
        d1: d1 ? d1.value : '', d2: d2 ? d2.value : '',
      };
    }, sec);

    check(r.fechas > 0, `${sec}: trae ruedas`, `${r.fechas}`);
    check(r.bonos > 0, `${sec}: arma series por bono`, `${r.bonos}`);
    check(r.chips === r.bonos, `${sec}: un chip por bono con datos`, `${r.chips} chips`);
    check(r.series === r.bonos, `${sec}: todos seleccionados al abrir`, `${r.series} líneas`);
    check(r.d1 < r.d2, `${sec}: rango por defecto válido`, `${r.d1} a ${r.d2}`);
    check(/%/.test(r.ejeY), `${sec}: eje Y con la métrica`, r.ejeY);

    // Destildar uno saca su línea
    const tog = await page.evaluate(s => {
      const st = seriesEstado[s];
      const t = [...st.cache.porBono.keys()].sort()[0];
      const antes = st.chart.data.datasets.length;
      seriesToggle(s, t);
      return { t, antes, despues: st.chart ? st.chart.data.datasets.length : -1 };
    }, sec);
    check(tog.despues === tog.antes - 1, `${sec}: destildar quita la línea`,
          `${tog.t}: ${tog.antes} → ${tog.despues}`);

    // Cambiar de sector recarga
    const otro = await page.evaluate(async s => {
      const cfg = SERIES_CFG[s];
      const dest = cfg.sectores[1].v;
      seriesSetSector(s, dest);
      await new Promise(r => setTimeout(r, 3000));
      const st = seriesEstado[s];
      return { dest, sector: st.sector, bonos: st.cache.porBono.size,
               ejeY: st.chart ? st.chart.options.scales.y.title.text : '' };
    }, sec);
    check(otro.sector === otro.dest, `${sec}: cambia de sector`, otro.dest);
    check(otro.bonos > 0, `${sec}: el sector nuevo trae datos`, `${otro.bonos} bonos`);
  }

  // Spread Leg. como serie temporal (solo USD)
  const slegSerie = await page.evaluate(async () => {
    seriesSetSector('usd', 'SLEG');
    await new Promise(r => setTimeout(r, 3000));
    const st = seriesEstado.usd;
    return {
      bonos: st.cache.porBono.size,
      pares: [...st.cache.porBono.keys()].slice(0, 3),
      ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
    };
  });
  check(slegSerie.bonos > 0, 'usd: Spread Leg. como serie', `${slegSerie.bonos} pares: ${slegSerie.pares.join(', ')}`);
  check(/Spread/.test(slegSerie.ejeY), 'usd: eje Y del spread', slegSerie.ejeY);

  console.log('\nResto de pestañas (no deben lanzar)');
  const antes = errores.length;
  await page.evaluate(() => switchSection('usd'));
  for (const t of ['usd-resumen', 'usd-forwards', 'usd-equiv', 'usd-curvas']) {
    await page.evaluate(x => switchUsdTab(x), t);
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => switchSection('pesos'));
  for (const t of ['breakeven', 'forwards', 'sintetico', 'calendario', 'proyecciones', 'curvas-ars']) {
    await page.evaluate(x => switchTab(x), t);
    await page.waitForTimeout(700);
  }
  check(errores.length === antes, 'ninguna pestaña lanzó errores',
        errores.slice(antes).slice(0, 3).join(' | '));

  console.log('\nHigiene');
  const undef = req400.filter(r => r.includes('/undefined'));
  check(undef.length === 0, 'sin peticiones a /undefined', undef.join(', '));
  const graves = errores.filter(e =>
    /is not defined|is not a function|before initialization|Cannot read/.test(e));
  check(graves.length === 0, 'sin ReferenceError/TypeError', graves.slice(0, 3).join(' | '));

  if (req400.length) {
    console.log('\n  peticiones con status >= 400:');
    for (const r of [...new Set(req400)].slice(0, 8)) console.log('    ' + r);
  }

  console.log(`\n${ok} OK · ${bad} fallas\n`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
