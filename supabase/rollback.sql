-- ═══════════════════════════════════════════════════════════════════════════
-- bonos-ar · Revertir policies.sql
--
-- Para cuando la migración se corrió en el proyecto equivocado.
--
-- Normalmente no hace falta: el SQL Editor de Supabase ejecuta el script en
-- una transacción implícita, así que si falló en la sección 5 todo lo
-- anterior ya se revirtió solo. Este archivo es para confirmarlo y limpiar
-- si algo quedó.
--
-- CORRER EN EL PROYECTO EQUIVOCADO, no en el de la app.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PASO 1 · Ver qué quedó ─────────────────────────────────────────────────
-- Correr esto solo primero. Si las tres columnas dan 'no existe', no hay
-- nada que limpiar y podés ignorar el paso 2.
--
-- Nota: no se referencia public.app_roles directamente. Postgres planifica
-- la consulta entera antes de ejecutarla, así que un "select ... from
-- app_roles" dentro de un CASE falla aunque esa rama nunca se evalúe.
-- Sólo se consultan los catálogos, que siempre existen.

select
  case when to_regclass('public.app_roles') is null
       then 'no existe' else 'EXISTE' end                       as tabla_app_roles,
  case when exists (select 1 from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'es_admin')
       then 'EXISTE' else 'no existe' end                       as fn_es_admin,
  case when exists (select 1 from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'puede_escribir_snapshots')
       then 'EXISTE' else 'no existe' end                       as fn_puede_escribir_snapshots;


-- ── PASO 2 · Limpiar ───────────────────────────────────────────────────────
-- Sólo si el paso 1 mostró algo con estado EXISTE.
-- Descomentá el bloque y corré.
--
-- No borra nada si app_roles tiene filas: en ese caso la tabla es tuya y
-- preexistente, no la creó esta migración. Ahí frená y avisá.

-- do $rb$
-- declare n integer;
-- begin
--   if to_regclass('public.app_roles') is not null then
--     -- EXECUTE difiere el parseo: si la tabla no existiera, no rompe al planificar
--     execute 'select count(*) from public.app_roles' into n;
--     if n > 0 then
--       raise exception 'app_roles tiene % filas: no la borro, puede ser tuya y anterior a esta migración.', n;
--     end if;
--     execute 'drop table public.app_roles';
--     raise notice 'app_roles borrada (estaba vacía).';
--   else
--     raise notice 'app_roles no existía.';
--   end if;
--
--   drop function if exists public.es_admin();
--   drop function if exists public.puede_escribir_snapshots();
--   raise notice 'Funciones borradas. Proyecto limpio.';
-- end $rb$;


-- ── Nota sobre las políticas ───────────────────────────────────────────────
-- La sección 4 de policies.sql borra políticas de shared_data,
-- bond_price_snapshots y user_data. Si en este proyecto esas tablas no
-- existen, el bucle no encontró nada y no tocó ninguna política.
--
-- Para confirmarlo, esto lista las políticas que hay hoy acá:

select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
