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

  console.log('\nForwards históricos');
  for (const [sec, tab, ir] of [
    ['ars', 'series-ars', 'switchTab'],
    ['usd', 'usd-series', 'switchUsdTab'],
  ]) {
    await page.evaluate(([t, fn]) => {
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
    }, [tab, ir]);
    await page.waitForTimeout(800);

    // Entrar al modo forwards. La sección USD quedó en Spread Leg., que no
    // tiene duración: el propio cambio de modo tiene que sacarla de ahí.
    const ent = await page.evaluate(async s => {
      seriesSetModo(s, 'fwd');
      await new Promise(r => setTimeout(r, 3500));
      const st = seriesEstado[s];
      const bar = document.getElementById(`series-${s}-fwdbar`);
      const selC = document.getElementById(`series-${s}-fwd-corto`);
      const selL = document.getElementById(`series-${s}-fwd-largo`);
      const sleg = document.getElementById(`series-${s}-chip-SLEG`);
      const tod = document.getElementById(`series-${s}-todos`);
      return {
        modo: st.modo, sector: st.sector,
        activo: document.getElementById(`series-${s}-modo-fwd`).classList.contains('active'),
        barra: bar ? bar.style.display : '',
        todos: tod ? tod.style.display : '',
        opciones: selC ? selC.options.length : 0,
        corto: selC ? selC.value : '', largo: selL ? selL.value : '',
        bonos: st.cacheFwd.porBono.size,
        conDur: [...st.cacheFwd.porBono.values()]
          .every(m => [...m.values()].every(v => v.dur > 0 && isFinite(v.tasa))),
        slegBloqueado: sleg ? sleg.disabled : null,
        pares: st.cache.porBono.size,
        lineas: st.chart ? st.chart.data.datasets.length : 0,
      };
    }, sec);
    check(ent.modo === 'fwd' && ent.activo, `${sec}: entra en modo forwards`);
    check(ent.barra === 'flex', `${sec}: aparece la barra de combinación`, ent.barra);
    check(ent.todos === 'none', `${sec}: se esconde Todos/Ninguno`, ent.todos);
    check(ent.sector !== 'SLEG', `${sec}: el spread no queda elegido`, ent.sector);
    check(ent.bonos > 1, `${sec}: trae tasa y duración por bono`, `${ent.bonos} bonos`);
    check(ent.conDur, `${sec}: toda fila tiene duración positiva y tasa finita`);
    check(ent.opciones === ent.bonos, `${sec}: un ítem por bono con datos`, `${ent.opciones}`);
    check(!!ent.corto && !!ent.largo && ent.corto !== ent.largo,
          `${sec}: arranca con corto y largo distintos`, `${ent.corto} / ${ent.largo}`);
    // El pedido explícito: no graficar todas las combinaciones por defecto.
    check(ent.pares === 0 && ent.lineas === 0, `${sec}: no grafica nada hasta elegir`, `${ent.pares} pares`);

    const add = await page.evaluate(s => {
      const st = seriesEstado[s];
      const c = document.getElementById(`series-${s}-fwd-corto`).value;
      const l = document.getElementById(`series-${s}-fwd-largo`).value;
      seriesFwdAgregar(s);
      const ds = st.chart ? st.chart.data.datasets : [];
      const serie = st.cache.porBono.get(c + '\u2192' + l);
      const vals = serie ? [...serie.values()] : [];
      // Recálculo del forward sobre la primera rueda con datos en ambos bonos:
      // confirma que la línea salió de ESTE par y no de otro.
      let esperado = null, obtenido = null;
      for (const f of st.cacheFwd.fechas) {
        const a = st.cacheFwd.porBono.get(c).get(f), b = st.cacheFwd.porBono.get(l).get(f);
        if (a && b && b.dur !== a.dur) {
          esperado = (b.tasa * b.dur - a.tasa * a.dur) / (b.dur - a.dur);
          obtenido = serie ? serie.get(f) : null;
          break;
        }
      }
      const guardado = (JSON.parse(localStorage.getItem('bonosAR_series_fwd_v1') || '{}').pares || {})[s] || {};
      return {
        c, l, lineas: ds.length, label: ds.length ? ds[0].label : '',
        puntos: vals.length, finitos: vals.length > 0 && vals.every(v => isFinite(v)),
        esperado, obtenido,
        ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
        chips: document.getElementById(`series-${s}-chips`).querySelectorAll('button').length,
        guardadas: (guardado[st.sector] || []).length,
      };
    }, sec);
    check(add.lineas === 1, `${sec}: agregar dibuja una línea`, `${add.lineas}`);
    check(add.label === `${add.c}\u2192${add.l}`, `${sec}: la serie se llama por el par`, add.label);
    check(add.finitos, `${sec}: la serie tiene puntos finitos`, `${add.puntos} puntos`);
    check(add.esperado !== null && Math.abs(add.esperado - add.obtenido) < 1e-9,
          `${sec}: el forward graficado es el del par elegido`, `${add.esperado} vs ${add.obtenido}`);
    check(/Forward/.test(add.ejeY), `${sec}: eje Y de forwards`, add.ejeY);
    check(add.chips === 1, `${sec}: un chip por combinación`, `${add.chips}`);
    check(add.guardadas === 1, `${sec}: la combinación queda guardada`, `${add.guardadas}`);

    const rech = await page.evaluate(s => {
      const st = seriesEstado[s];
      const n0 = st.cache.porBono.size;
      seriesFwdAgregar(s);                                  // el mismo par de nuevo
      const dup = st.cache.porBono.size;
      const selC = document.getElementById(`series-${s}-fwd-corto`);
      const selL = document.getElementById(`series-${s}-fwd-largo`);
      selL.value = selC.value;
      seriesFwdAgregar(s);                                  // un bono contra sí mismo
      return { n0, dup, igual: st.cache.porBono.size,
               msg: document.getElementById(`series-${s}-msg`).textContent };
    }, sec);
    check(rech.dup === rech.n0, `${sec}: no repite una combinación`, `${rech.dup}`);
    check(rech.igual === rech.n0, `${sec}: rechaza un bono contra sí mismo`, rech.msg);

    const quit = await page.evaluate(s => {
      const st = seriesEstado[s];
      const [c, l] = [...st.cache.porBono.keys()][0].split('\u2192');
      seriesFwdQuitar(s, c, l);
      return { pares: st.cache.porBono.size, lineas: st.chart ? st.chart.data.datasets.length : 0 };
    }, sec);
    check(quit.pares === 0 && quit.lineas === 0, `${sec}: quitar saca la línea`, `${quit.pares}`);

    // Volver a tasas para no arrastrar el modo a las verificaciones siguientes
    await page.evaluate(async s => {
      seriesSetModo(s, 'tasas');
      await new Promise(r => setTimeout(r, 2500));
    }, sec);
    const vuelta = await page.evaluate(s => {
      const st = seriesEstado[s];
      const bar = document.getElementById(`series-${s}-fwdbar`);
      return { modo: st.modo, barra: bar ? bar.style.display : '', bonos: st.cache.porBono.size,
               ejeY: st.chart ? st.chart.options.scales.y.title.text : '' };
    }, sec);
    check(vuelta.modo === 'tasas' && vuelta.barra === 'none', `${sec}: vuelve a modo tasas`);
    check(vuelta.bonos > 0 && !/Forward/.test(vuelta.ejeY), `${sec}: recupera la serie de tasas`, vuelta.ejeY);
  }

  console.log('\nMAE — mayorista y futuros de dólar');

  // Lo puro primero: no depende de la red ni del horario.
  const puro = await page.evaluate(() => ({
    // El MAE serializa la hora argentina con forma de unix UTC. 1788965197 es
    // 14:59 leyéndolo en UTC, y eso es justo lo que hay que mostrar.
    hora: maeHoraART(1788965197),
    // DLR + MM + YYYY
    tk: maeTickerFromVcto('2026-09-30'),
    tkEnero: maeTickerFromVcto('2027-01-15'),
    tkNulo: maeTickerFromVcto('no-es-fecha'),
    tieneCierre: typeof MAE_CIERRE_H === 'number' && MAE_CIERRE_H === 15,
  }));
  check(puro.hora === '14:59', 'la hora del MAE no se corre 3 horas', puro.hora);
  check(puro.tk === 'DLR092026', 'mapea vencimiento a contrato', puro.tk);
  check(puro.tkEnero === 'DLR012027', 'rellena el mes con cero', puro.tkEnero);
  check(puro.tkNulo === null, 'una fecha inválida no arma ticker', String(puro.tkNulo));
  check(puro.tieneCierre, 'el cierre de la rueda mayorista es a las 15');

  // Precedencia del A3500. Es la razón de ser del refactor: antes el refresco
  // escribía en dlkTCOverride y te pisaba el valor que habías puesto a mano.
  const prec = await page.evaluate(() => {
    const overAntes = dlkTCOverride, liveAntes = A3500_LIVE;
    const out = {};
    dlkTCOverride = null; A3500_LIVE = { valor: 1111.11, hora: '12:34' };
    out.live = dlkTCHoy(); out.fuenteLive = dlkTCFuente().tipo;
    dlkTCOverride = 2222.22;
    out.manual = dlkTCHoy(); out.fuenteManual = dlkTCFuente().tipo;
    dlkTCOverride = null; A3500_LIVE = null;
    out.sinNada = dlkTCHoy(); out.fuenteSinNada = dlkTCFuente().tipo;
    out.dlkLen = DLK_INDEX.length;
    dlkTCOverride = overAntes; A3500_LIVE = liveAntes;
    return out;
  });
  check(prec.manual === 2222.22 && prec.fuenteManual === 'manual',
        'el valor manual le gana al live', `${prec.manual} / ${prec.fuenteManual}`);
  check(prec.live === 1111.11 && prec.fuenteLive === 'mae',
        'sin manual, manda el mayorista del MAE', `${prec.live} / ${prec.fuenteLive}`);
  if (prec.dlkLen > 0) {
    check(prec.sinNada != null && ['oficial', 'cierre'].includes(prec.fuenteSinNada),
          'sin manual ni live, cae al A3500 del BCRA', `${prec.sinNada} / ${prec.fuenteSinNada}`);
  } else {
    console.log('  \x1b[33m--\x1b[0m    el índice del BCRA no cargó: no se verifica el fallback');
  }

  // La red, solo si la rueda está abierta: fuera de 10-15 ART no hay nada nuevo
  // que pedir y afirmar lo contrario haría fallar el build por horario.
  const red = await page.evaluate(async () => {
    if (!maeRuedaAbierta()) return { cerrada: true };
    try {
      const spot = await maeFetchSpot();
      const curva = await maeFetchFuturos();
      return {
        cerrada: false,
        spot: spot && spot.valor, hora: spot && spot.hora,
        n: curva.length,
        ordenada: curva.every((c, i) => i === 0 ||
          (c.anio > curva[i - 1].anio || (c.anio === curva[i - 1].anio && c.mes > curva[i - 1].mes))),
        precios: curva.every(c => c.precio > 0),
      };
    } catch (e) { return { cerrada: false, error: e.message }; }
  });
  if (red.cerrada) {
    console.log('  \x1b[33m--\x1b[0m    rueda mayorista cerrada: no se verifica la red del MAE');
  } else if (red.error) {
    // Sin el Worker redeployado con la ruta /mae esto falla, y tiene que verse.
    check(false, 'el MAE responde por el Worker', red.error);
  } else {
    check(red.spot > 0, 'llega el mayorista contado', `${red.spot} a las ${red.hora}`);
    check(red.n >= 6, 'llega la curva de futuros', `${red.n} contratos`);
    check(red.ordenada, 'la curva viene ordenada por vencimiento');
    check(red.precios, 'todos los contratos traen precio');
  }

  // IOL se eliminó por completo: no debe quedar ni el modal ni las credenciales.
  const iol = await page.evaluate(() => ({
    modal: !!document.getElementById('iol-creds-modal'),
    funcs: ['rofexFetch', 'iolGetToken', 'iolCredsOpen', 'iolAuth']
      .filter(f => typeof window[f] === 'function'),
    creds: !!localStorage.getItem('bonosAR_iol_creds_v1'),
    token: !!localStorage.getItem('bonosAR_iol_token_v1'),
    boton: (document.getElementById('sint-rofex-btn') || {}).textContent || '',
  }));
  check(!iol.modal, 'no queda el modal de credenciales de IOL');
  check(iol.funcs.length === 0, 'no quedan funciones de IOL', iol.funcs.join(', '));
  check(!iol.creds && !iol.token, 'las credenciales guardadas de IOL se borran');
  check(/MAE/.test(iol.boton), 'el botón de futuros apunta al MAE', iol.boton);

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
