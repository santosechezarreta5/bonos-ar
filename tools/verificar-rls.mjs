// Verifica que las políticas de RLS estén activas, probando de verdad.
//
//   node tools/verificar-rls.mjs
//
// No alcanza con mirar el catálogo: lo que importa es si un cliente anónimo
// —con la misma clave pública que está en index.html, que cualquiera puede
// leer— consigue escribir. Este script lo intenta y espera ser rechazado.
//
// Las escrituras que prueba están diseñadas para no ensuciar nada: usan un
// ticker marcador y una fecha imposible. Si alguna llegara a pasar, el
// script avisa y trata de borrar lo que insertó.

import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const URL_SUPA = html.match(/const SUPA_URL='([^']+)'/)?.[1];
const KEY = html.match(/const SUPA_KEY='([^']+)'/)?.[1];
if (!URL_SUPA || !KEY) { console.error('No pude leer SUPA_URL / SUPA_KEY de index.html'); process.exit(1); }

const MARCA = '__RLS_TEST__';
const FECHA = '1990-01-01';

const h = {
  'apikey': KEY,
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

let ok = 0, bad = 0;
const r = (pass, label, detalle = '') => {
  if (pass) { ok++;  console.log(`  \x1b[32mOK\x1b[0m    ${label}`); }
  else      { bad++; console.log(`  \x1b[31mFALLA\x1b[0m ${label}${detalle ? '  → ' + detalle : ''}`); }
};

const req = async (method, path, body, extra = {}) => {
  const res = await fetch(`${URL_SUPA}/rest/v1/${path}`, {
    method, headers: { ...h, ...extra }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, texto: await res.text() };
};

const rechazado = s => s === 401 || s === 403;

// Un UPDATE bloqueado por RLS no devuelve 4xx: la cláusula USING filtra las
// filas, el UPDATE no encuentra ninguna y PostgREST responde 204 (o 200 con
// lista vacía). Lo correcto es exigir que afecte CERO filas, y para verlo hay
// que pedir return=representation.
const updateSinEfecto = async (path, body) => {
  const res = await req('PATCH', path, body, { 'Prefer': 'return=representation' });
  if (rechazado(res.status)) return { pass: true, detalle: `HTTP ${res.status} (rechazado)` };
  if (res.status === 200 || res.status === 204) {
    let filas = 0;
    try { filas = JSON.parse(res.texto || '[]').length; } catch { filas = 0; }
    return { pass: filas === 0, detalle: `HTTP ${res.status}, ${filas} filas afectadas` };
  }
  return { pass: false, detalle: `HTTP ${res.status} ${res.texto.slice(0, 100)}` };
};

console.log(`\nProbando como ANÓNIMO contra ${URL_SUPA}\n`);

console.log('Lectura — debe seguir funcionando (la app lee antes de loguearse)');
const l1 = await req('GET', 'shared_data?select=key&limit=1');
r(l1.status === 200, 'shared_data legible', `HTTP ${l1.status}`);
const l2 = await req('GET', 'bond_price_snapshots?select=ticker&limit=1');
r(l2.status === 200, 'bond_price_snapshots legible', `HTTP ${l2.status}`);

console.log('\nSEC-2 — el histórico NO debe aceptar escritura anónima');
const w1 = await req('POST', 'bond_price_snapshots', [{
  snapshot_date: FECHA, ticker: MARCA, sector: 'TF', price: 1, tir: 1, md: 1, dias: 1,
}]);
r(rechazado(w1.status), 'insert rechazado', `HTTP ${w1.status} ${w1.texto.slice(0, 120)}`);
if (!rechazado(w1.status)) {
  console.log('    \x1b[31m↑ SE ESCRIBIÓ. Intentando borrar la fila de prueba...\x1b[0m');
  const del = await req('DELETE', `bond_price_snapshots?ticker=eq.${MARCA}`);
  console.log(`    borrado: HTTP ${del.status}${rechazado(del.status) ? ' — borrala a mano desde el dashboard' : ''}`);
}

const w2 = await updateSinEfecto('bond_price_snapshots?ticker=eq.AL29', { price: 999999 });
r(w2.pass, 'update sin efecto', w2.detalle);

console.log('\nSEC-4 — las definiciones de bonos NO deben aceptar escritura anónima');
const w3 = await req('POST', 'shared_data', [{ key: MARCA, value: [] }]);
r(rechazado(w3.status), 'insert rechazado', `HTTP ${w3.status} ${w3.texto.slice(0, 120)}`);
if (!rechazado(w3.status)) {
  console.log('    \x1b[31m↑ SE ESCRIBIÓ. Intentando borrar...\x1b[0m');
  const del = await req('DELETE', `shared_data?key=eq.${MARCA}`);
  console.log(`    borrado: HTTP ${del.status}`);
}
const w4 = await updateSinEfecto('shared_data?key=eq.bonosAR_lecaps_v1', { value: [] });
r(w4.pass, 'update sin efecto', w4.detalle);

console.log('\nuser_data — no debe filtrar configuración de nadie');
const u = await req('GET', 'user_data?select=user_id,key&limit=5');
const filas = u.status === 200 ? JSON.parse(u.texto).length : -1;
r(u.status === 200 ? filas === 0 : rechazado(u.status),
  'sin acceso anónimo', u.status === 200 ? `devolvió ${filas} filas` : `HTTP ${u.status}`);

console.log(`\n${ok} OK · ${bad} fallas\n`);
if (bad) console.log('Revisá supabase/policies.sql y confirmá que corriste la migración en el proyecto correcto.\n');
process.exit(bad ? 1 : 0);
