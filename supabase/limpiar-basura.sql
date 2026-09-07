-- ═══════════════════════════════════════════════════════════════════════════
-- bonos-ar · Limpiar filas basura de bond_price_snapshots
--
-- Supabase Dashboard → SQL Editor. Correr el PASO 1 primero.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PASO 1 · Ver qué se va a borrar ────────────────────────────────────────

-- a) Filas de prueba (ticker TEST o fechas imposibles)
select 'prueba' as motivo, snapshot_date, ticker, sector, price, tir, created_at
from public.bond_price_snapshots
where ticker in ('TEST','__RLS_TEST__')
   or snapshot_date > current_date + interval '7 days'
   or snapshot_date < date '2020-01-01'

union all

-- b) Días enteros sin ninguna TIR: los escribió el cron del Worker, que sólo
--    guarda precios. La pestaña Curvas filtra tir != null, así que esos días
--    no se ven y parecen datos faltantes.
select 'sin TIR', s.snapshot_date, s.ticker, s.sector, s.price, s.tir, s.created_at
from public.bond_price_snapshots s
join (
  select snapshot_date
  from public.bond_price_snapshots
  group by snapshot_date
  having count(tir) = 0          -- ninguna fila del día tiene TIR
) d on d.snapshot_date = s.snapshot_date

union all

-- c) Fines de semana: el mercado no opera. Estas filas las escribió el
--    navegador con la app abierta un sábado o domingo, guardando los precios
--    del viernes bajo una fecha en la que no hubo rueda.
select 'fin de semana', snapshot_date, ticker, sector, price, tir, created_at
from public.bond_price_snapshots
where extract(dow from snapshot_date) in (0, 6)   -- 0 = domingo, 6 = sábado

order by snapshot_date, ticker;


-- ── PASO 2 · Borrar ────────────────────────────────────────────────────────
-- Descomentar y correr sólo después de revisar el paso 1.
--
-- Ojo: no borra días parcialmente completos. Sólo los que no tienen NINGUNA
-- TIR, que son los que escribió el Worker sin que después pasara el Action.

-- begin;
--
-- delete from public.bond_price_snapshots
-- where ticker in ('TEST','__RLS_TEST__')
--    or snapshot_date > current_date + interval '7 days'
--    or snapshot_date < date '2020-01-01';
--
-- delete from public.bond_price_snapshots
-- where snapshot_date in (
--   select snapshot_date
--   from public.bond_price_snapshots
--   group by snapshot_date
--   having count(tir) = 0
-- );
--
-- delete from public.bond_price_snapshots
-- where extract(dow from snapshot_date) in (0, 6);
--
-- commit;
--
-- Si el editor no ejecuta el bloque begin/commit, corré cada delete suelto:
-- el SQL Editor de Supabase a veces ignora el control de transacción y por
-- eso una corrida puede parecer aplicada sin haber borrado nada.


-- ── PASO 3 · Estado del histórico ──────────────────────────────────────────
-- Correr después de limpiar. Todos los días deberían tener con_tir = filas.

select
  snapshot_date,
  count(*)                                    as filas,
  count(tir)                                  as con_tir,
  count(distinct sector)                      as sectores,
  to_char(snapshot_date, 'Dy')                as dia
from public.bond_price_snapshots
group by snapshot_date
order by snapshot_date desc
limit 20;
