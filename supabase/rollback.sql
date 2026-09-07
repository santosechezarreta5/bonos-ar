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
-- Correr esto solo primero. Si las tres filas dan 'no existe', no hay nada
-- que limpiar y podés ignorar el paso 2.

select 'tabla app_roles' as objeto,
       case when to_regclass('public.app_roles') is null
            then 'no existe' else 'EXISTE' end as estado,
       case when to_regclass('public.app_roles') is null
            then null else (select count(*)::text || ' filas' from public.app_roles) end as detalle
union all
select 'función es_admin()',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='es_admin')
            then 'EXISTE' else 'no existe' end, null
union all
select 'función puede_escribir_snapshots()',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='puede_escribir_snapshots')
            then 'EXISTE' else 'no existe' end, null;


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
--     select count(*) into n from public.app_roles;
--     if n > 0 then
--       raise exception 'app_roles tiene % filas: no la borro, puede ser tuya y anterior a esta migración.', n;
--     end if;
--     drop table public.app_roles;
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
