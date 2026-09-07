// Diagnóstico temporal: traza quién pide /undefined.
// Instala envoltorios sobre fetch, XHR e img.src ANTES de que corra la app,
// y captura el stack en el momento de la llamada.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  await page.addInitScript(() => {
    window.__trazas = [];
    const sospechoso = u => {
      try { return String(u).includes('undefined'); } catch { return false; }
    };
    const anotar = (via, u) => {
      window.__trazas.push({ via, url: String(u), stack: new Error().stack });
    };

    const of = window.fetch;
    window.fetch = function (u, ...r) {
      if (sospechoso(u)) anotar('fetch', u);
      return of.call(this, u, ...r);
    };

    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      if (sospechoso(u)) anotar('XHR', u);
      return oo.call(this, m, u, ...r);
    };

    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get() { return desc.get.call(this); },
      set(v) { if (sospechoso(v)) anotar('img.src', v); return desc.set.call(this, v); },
    });

    // innerHTML con src="undefined" no pasa por el setter de arriba
    const oi = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
      get() { return oi.get.call(this); },
      set(v) {
        if (typeof v === 'string' && /(?:src|href)\s*=\s*["']?undefined/.test(v))
          anotar('innerHTML', v.slice(0, 200));
        return oi.set.call(this, v);
      },
    });
  });

  page.on('response', r => {
    if (r.status() >= 400) console.log(`[HTTP ${r.status()}] ${r.url()}`);
  });

  await page.goto('https://santosechezarreta5.github.io/bonos-ar/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(20000);

  const t = await page.evaluate(() => window.__trazas);
  console.log(`\n${'='.repeat(70)}\nTrazas capturadas: ${t.length}\n${'='.repeat(70)}`);
  for (const x of t) {
    console.log(`\nvía: ${x.via}\nurl: ${x.url}`);
    console.log('stack:');
    for (const l of (x.stack || '').split('\n').slice(1, 7)) console.log('   ' + l.trim());
  }
  await browser.close();
})();
