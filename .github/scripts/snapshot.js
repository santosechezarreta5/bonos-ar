const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  page.on('console', msg => {
    if (['error', 'warn'].includes(msg.type()))
      console.log(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', err => console.error('Page error:', err.message));

  console.log('Loading app...');
  await page.goto('https://santosechezarreta5.github.io/bonos-ar/');

  // Esperamos 15s para que fetchPrices() cargue los precios ARS (data912 es rápido)
  console.log('Waiting for initial price load (15s)...');
  await page.waitForTimeout(15000);

  // Limpiamos cooldown y corremos el snapshot completo.
  // Internamente: awaita cerFetchIndex() si CER_INDEX está vacío (~20-30s)
  // y llama usdRefreshPrices() si los bonos USD no tienen precio.
  console.log('Running full snapshot...');
  await page.evaluate(async () => {
    localStorage.removeItem('bonosAR_curvas_snap_date_v1');
    await curvasSnapshotToday();
  });

  // Pausa extra para que terminen los upserts por sector
  await page.waitForTimeout(5000);

  const raw = await page.evaluate(() => localStorage.getItem('bonosAR_curvas_snap_date_v1'));
  const sectors = raw ? Object.keys(JSON.parse(raw)) : [];
  console.log('Sectors saved:', sectors.length ? sectors.join(', ') : 'NONE');

  await browser.close();

  if (sectors.length === 0) {
    console.error('Snapshot failed — no sectors were saved.');
    process.exit(1);
  }

  console.log('Done.');
})();
