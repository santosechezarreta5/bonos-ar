-- ═══════════════════════════════════════════════════════════════════════════
-- bonos-ar · Permitir el mismo ticker en dos sectores el mismo día
--
-- BE-1, diagnóstico corregido.
--
-- La tabla tiene una constraint única sobre (snapshot_date, ticker). Como no
-- incluye el sector, un ticker que existe en dos listas sólo puede guardarse
-- una vez por día: la segunda escritura pisa a la primera.
--
-- Afecta a TXMJ9, TXMJ8, TXMD8, TXMD9, TXMJ0 (CER y TAMAR) y a TMVE8
-- (TAMAR y DLK). Los cinco primeros nunca aparecen en la curva CER, y TMVE8
-- salta entre la curva TAMAR y la DLK según qué sector escribió último ese
-- día, lo que deforma el ajuste.
--
-- Deduplicar por (sector, ticker) en el código no alcanzaba: manda las dos
-- filas, pero la base sigue admitiendo una sola.
--
-- Supabase Dashboard → SQL Editor. Correr el PASO 1 primero.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PASO 1 · Ver qué restricción existe hoy ────────────────────────────────

select
  con.conname                                        as nombre,
  case con.contype when 'p' then 'primary key'
                   when 'u' then 'unique' end        as tipo,
  pg_get_constraintdef(con.oid)                      as definicion
from pg_constraint con
where con.conrelid = 'public.bond_price_snapshots'::regclass
  and con.contype in ('p','u')

union all

select
  i.relname,
  'unique index',
  pg_get_indexdef(i.oid)
from pg_index x
join pg_class i on i.oid = x.indexrelid
where x.indrelid = 'public.bond_price_snapshots'::regclass
  and x.indisunique
  and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid);


-- ── PASO 2 · Migrar ────────────────────────────────────────────────────────
-- Descomentar y correr. Es idempotente.
--
-- Busca la restricción única que cubre exactamente (snapshot_date, ticker),
-- la reemplaza por una sobre (snapshot_date, ticker, sector) y avisa qué hizo.

-- do $fix$
-- declare
--   nombre text;
--   es_indice boolean := false;
-- begin
--   -- ¿ya está la nueva?
--   if exists (
--     select 1 from pg_constraint con
--     where con.conrelid = 'public.bond_price_snapshots'::regclass
--       and con.contype in ('p','u')
--       and pg_get_constraintdef(con.oid) ~ 'snapshot_date.*ticker.*sector'
--   ) then
--     raise notice 'Ya existe una restricción que incluye sector. Nada que hacer.';
--     return;
--   end if;
--
--   -- buscar la vieja, como constraint
--   select con.conname into nombre
--   from pg_constraint con
--   where con.conrelid = 'public.bond_price_snapshots'::regclass
--     and con.contype in ('p','u')
--     and pg_get_constraintdef(con.oid) ~ '\(snapshot_date, ticker\)';
--
--   if nombre is null then
--     -- o como índice único suelto
--     select i.relname into nombre
--     from pg_index x join pg_class i on i.oid = x.indexrelid
--     where x.indrelid = 'public.bond_price_snapshots'::regclass
--       and x.indisunique
--       and pg_get_indexdef(i.oid) ~ '\(snapshot_date, ticker\)';
--     es_indice := nombre is not null;
--   end if;
--
--   if nombre is null then
--     raise exception 'No encontré una restricción única sobre (snapshot_date, ticker). Mirá el resultado del PASO 1 y avisá.';
--   end if;
--
--   if es_indice then
--     execute format('drop index public.%I', nombre);
--     raise notice 'Índice único % borrado.', nombre;
--   else
--     execute format('alter table public.bond_price_snapshots drop constraint %I', nombre);
--     raise notice 'Constraint % borrada.', nombre;
--   end if;
--
--   alter table public.bond_price_snapshots
--     add constraint bond_price_snapshots_fecha_ticker_sector_key
--     unique (snapshot_date, ticker, sector);
--
--   raise notice 'Nueva restricción sobre (snapshot_date, ticker, sector) creada.';
-- end $fix$;


-- ── PASO 3 · Verificar ─────────────────────────────────────────────────────
-- Después del próximo snapshot, esto debería devolver filas: los tickers que
-- por fin conviven en dos sectores el mismo día.

select snapshot_date, ticker, string_agg(sector, ' + ' order by sector) as sectores
from public.bond_price_snapshots
where ticker in ('TXMJ9','TXMJ8','TXMD8','TXMD9','TXMJ0','TMVE8')
group by snapshot_date, ticker
having count(*) > 1
order by snapshot_date desc, ticker;
