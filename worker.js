// ═══════════════════════════════════════════════════════════════════════════════
// royal-resonance-d470  —  worker.js
// Rutas existentes: /rofex · /iol · BCRA proxy (default)
// Nuevo: /test-snapshot (POST) · scheduled cron (weekdays 20:15 UTC = 17:15 ART)
//
// Variables de entorno a agregar en Cloudflare Dashboard → Settings → Variables:
//   SUPABASE_URL          https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (bypasa RLS)
//
// Cron trigger: 15 20 * * 1-5
//   Cloudflare Dashboard → Workers & Pages → royal-resonance-d470
//   → Triggers → Cron Triggers → Add Cron Trigger → "15 20 * * 1-5"
// ═══════════════════════════════════════════════════════════════════════════════

// Devuelve 'YYYY-MM-DD' en hora argentina (UTC-3, sin DST)
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// ── Precios data912.com ────────────────────────────────────────────────────────
function apiBestPrice(api) {
  if (!api) return null;
  if (api.c > 0) return api.c;
  const bid = api.px_bid||0, ask = api.px_ask||0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return ask || bid || null;
}
async function fetchData912() {
  const ts = Date.now();
  const [rN, rB] = await Promise.all([
    fetch(`https://data912.com/live/arg_notes?_=${ts}`).then(r => r.json()),
    fetch(`https://data912.com/live/arg_bonds?_=${ts}`).then(r => r.json()),
  ]);
  return new Map([...rN, ...rB].map(x => [x.symbol, x]));
}

// ── Supabase helpers ───────────────────────────────────────────────────────────
function supaHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}
async function supaGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function supaUpsert(env, table, rows, onConflict) {
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table} → ${res.status}: ${await res.text()}`);
}

// ── Snapshot diario ────────────────────────────────────────────────────────────
// El Worker solo guarda precios. El frontend calcula TIR/MD desde el precio
// histórico + la definición estática del bono.
//
// Para USD (BOP/BON/GLO) los precios en data912 no están bajo bond.ticker sino
// bajo los símbolos de EQUIV_DATA (ej. "GD30D" para MEP de GD30).
// Se usa el precio MEP (row.mep) como precio USD de referencia.
async function takeDailySnapshot(env) {
  const todayStr = todayAR();

  const KEYS = [
    'bonosAR_glo_v1', 'bonosAR_bon_v1', 'bonosAR_bop_v1',
    'bonosAR_lecaps_v1', 'bonosAR_cer_bonds_v1',
    'bonosAR_tamar_bonds_v1', 'bonosAR_dlk_bonds_v1',
    'bonosAR_equiv_v1',
  ];
  const USD_SECTORS = new Set(['GLO', 'BON', 'BOP']);
  const SECTOR = {
    bonosAR_glo_v1:         'GLO',
    bonosAR_bon_v1:         'BON',
    bonosAR_bop_v1:         'BOP',
    bonosAR_lecaps_v1:      'TF',
    bonosAR_cer_bonds_v1:   'CER',
    bonosAR_tamar_bonds_v1: 'TAMAR',
    bonosAR_dlk_bonds_v1:   'DLK',
  };

  const [priceMap, sharedRows] = await Promise.all([
    fetchData912(),
    supaGet(env, `shared_data?key=in.(${KEYS.join(',')})&select=key,value`),
  ]);

  // Construir mapa equiv: bond.ticker → {ars, mep, cable}
  const equivRaw = sharedRows.find(r => r.key === 'bonosAR_equiv_v1');
  const equivList = equivRaw ? (Array.isArray(equivRaw.value) ? equivRaw.value : JSON.parse(equivRaw.value)) : [];
  const equivMap = new Map(equivList.map(e => [e.ticker, e]));

  const rows = [];
  for (const row of sharedRows) {
    const sector = SECTOR[row.key];
    if (!sector) continue; // bonosAR_equiv_v1 no tiene sector
    const bonds = Array.isArray(row.value) ? row.value : JSON.parse(row.value);

    for (const bond of bonds) {
      let price = null;

      if (USD_SECTORS.has(sector)) {
        // USD: buscar por símbolo MEP (precio en dólares)
        const eq = equivMap.get(bond.ticker);
        const sym = eq?.mep || eq?.cable;
        if (sym) price = apiBestPrice(priceMap.get(sym));
      } else {
        // ARS: buscar directamente por ticker
        price = apiBestPrice(priceMap.get(bond.ticker));
      }

      if (!price) continue;
      rows.push({ snapshot_date: todayStr, ticker: bond.ticker, sector, price: +price.toFixed(4) });
    }
  }

  // Deduplicar: si el mismo ticker aparece en más de una lista, queda el último
  const deduped = [...new Map(rows.map(r => [r.ticker, r])).values()];

  if (deduped.length) await supaUpsert(env, 'bond_price_snapshots', deduped, 'snapshot_date,ticker');
  return deduped.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // Snapshot manual (para probar sin esperar el cron)
    if (url.pathname === '/test-snapshot') {
      if (request.method !== 'POST') return new Response('POST required', { status: 405, headers: cors });
      try {
        const n = await takeDailySnapshot(env);
        return new Response(JSON.stringify({ ok: true, rows: n, date: todayAR() }),
          { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
      }
    }

    if (url.pathname === '/rofex') return handleRofex(env, cors);

    if (url.pathname === '/iol') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing url param', { status: 400 });
      const authHeader = request.headers.get('Authorization') || '';
      const iolHeaders = { 'Authorization': authHeader };
      if (request.method === 'POST')
        iolHeaders['Content-Type'] = request.headers.get('Content-Type') || 'application/x-www-form-urlencoded';
      const iolRes = await fetch(target, {
        method: request.method,
        headers: iolHeaders,
        body: request.method === 'POST' ? request.body : undefined,
      });
      const body = await iolRes.text();
      return new Response(body, { status: iolRes.status, headers: { 'Content-Type': 'application/json', ...cors } });
    }

    // BCRA proxy (default)
    const id     = url.searchParams.get('id')     || '30';
    const desde  = url.searchParams.get('desde')  || '2002-01-01';
    const limit  = url.searchParams.get('limit')  || '15000';
    const offset = url.searchParams.get('offset') || '0';
    const bcraTarget = `https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/${id}?desde=${desde}&limit=${limit}&offset=${offset}`;
    const resp = await fetch(bcraTarget, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...cors } });
  },

  // Cron: 15 20 * * 1-5  (lunes-viernes 20:15 UTC = 17:15 ART)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(takeDailySnapshot(env));
  },
};

// ── Rofex / Primary Markets ────────────────────────────────────────────────────
async function handleRofex(env, cors) {
  const BASE = env.PRIMARY_URL || 'https://api.remarkets.primary.com.ar';
  const user = env.PRIMARY_USER;
  const pass = env.PRIMARY_PASS;

  if (!user || !pass) {
    return new Response(JSON.stringify({ error: 'Faltan credenciales PRIMARY_USER / PRIMARY_PASS' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  const authResp = await fetch(`${BASE}/auth/getToken`, {
    method: 'POST',
    headers: { 'X-Username': user, 'X-Password': pass },
  });
  if (!authResp.ok)
    return new Response(JSON.stringify({ error: `Auth fallida: ${authResp.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...cors } });

  const token = authResp.headers.get('X-Auth-Token');
  if (!token)
    return new Response(JSON.stringify({ error: 'Sin token en respuesta de Primary' }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...cors } });

  const MESES = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const MESES_IDX = Object.fromEntries(MESES.map((m, i) => [m, i]));
  const now = new Date();
  const symbols = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    symbols.push(`DLR/${MESES[d.getMonth()]}${String(d.getFullYear()).slice(-2)}M`);
  }

  const results = await Promise.all(
    symbols.map(sym =>
      fetch(`${BASE}/rest/marketdata/get?marketId=ROFX&symbol=${encodeURIComponent(sym)}&entries=LA,OF,BI`, {
        headers: { 'X-Auth-Token': token },
      })
      .then(r => r.ok ? r.json().then(j => ({ sym, j })) : null)
      .catch(() => null)
    )
  );

  const contratos = results
    .filter(r => r?.j?.status === 'OK')
    .map(({ sym, j }) => {
      const md = j.marketData;
      const precio = md?.LA?.price || md?.OF?.price || md?.BI?.price || null;
      const abrev = sym.replace('DLR/', '').replace('M', '');
      const mes = abrev.slice(0, 3);
      const year = 2000 + parseInt(abrev.slice(3));
      const month = MESES_IDX[mes];
      const lastDay = new Date(year, month + 1, 0);
      while (lastDay.getDay() === 0 || lastDay.getDay() === 6) lastDay.setDate(lastDay.getDate() - 1);
      const vcto = lastDay.toISOString().split('T')[0];
      return { simbolo: sym, precio, vcto };
    })
    .sort((a, b) => a.vcto.localeCompare(b.vcto));

  return new Response(JSON.stringify(contratos), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300', ...cors },
  });
}
