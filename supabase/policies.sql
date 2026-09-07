-- ═══════════════════════════════════════════════════════════════════════════
-- bonos-ar · Políticas de Row Level Security
--
-- Corrige SEC-2 (cualquiera podía escribir el histórico de precios) y
-- SEC-4 (cualquier usuario logueado podía reescribir las definiciones de
-- bonos de todo el equipo).
--
-- CÓMO EJECUTARLO
--   Supabase Dashboard → SQL Editor → New query → pegar todo → Run.
--   Es idempotente: se puede correr varias veces sin romper nada.
--
-- ANTES DE CORRERLO, completá los dos UUID de la sección 2.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Tabla de roles ──────────────────────────────────────────────────────
-- 'admin'    → edita definiciones de bonos (shared_data) y snapshots
-- 'snapshot' → sólo escribe bond_price_snapshots (cuenta del GitHub Action)

create table if not exists public.app_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','snapshot')),
  nota       text,
  created_at timestamptz not null default now()
);

alter table public.app_roles enable row level security;

-- Nadie lee ni escribe esta tabla desde el cliente. Se administra sólo desde
-- el dashboard (service_role saltea RLS). Sin políticas = sin acceso.


-- ── 2. Cargar los usuarios ─────────────────────────────────────────────────
-- Buscá los UUID en: Dashboard → Authentication → Users (columna UID).
--
--   · Tu cuenta de Google (santosechezarreta5@gmail.com)  → 'admin'
--   · La cuenta del bot que vas a crear para el snapshot  → 'snapshot'
--
-- Reemplazá los dos placeholders y descomentá el bloque.

-- insert into public.app_roles (user_id, role, nota) values
--   ('00000000-0000-0000-0000-000000000000', 'admin',    'Santos — cuenta personal'),
--   ('11111111-1111-1111-1111-111111111111', 'snapshot', 'Bot del GitHub Action')
-- on conflict (user_id) do update set role = excluded.role, nota = excluded.nota;


-- ── 3. Funciones de permiso ────────────────────────────────────────────────
-- SECURITY DEFINER para que puedan leer app_roles sin que RLS las bloquee.
-- Sin esto las políticas entrarían en recursión contra la propia tabla.

create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.puede_escribir_snapshots()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_roles
    where user_id = auth.uid() and role in ('admin','snapshot')
  );
$$;

revoke all on function public.es_admin() from public;
revoke all on function public.puede_escribir_snapshots() from public;
grant execute on function public.es_admin() to anon, authenticated;
grant execute on function public.puede_escribir_snapshots() to anon, authenticated;


-- ── 4. Limpiar políticas previas ───────────────────────────────────────────
-- No conocemos los nombres que quedaron de antes, así que las borramos todas
-- por catálogo antes de recrear.

do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('shared_data','bond_price_snapshots','user_data')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;


-- ── 5. shared_data — definiciones de bonos ─────────────────────────────────
-- Lectura pública: authInit() carga estos datos ANTES de verificar la sesión,
-- así que restringirla rompería el arranque de la app.
-- Escritura: sólo admin.

alter table public.shared_data enable row level security;

create policy "shared_data · lectura pública"
  on public.shared_data for select
  to anon, authenticated
  using (true);

create policy "shared_data · alta admin"
  on public.shared_data for insert
  to authenticated
  with check (public.es_admin());

create policy "shared_data · modificación admin"
  on public.shared_data for update
  to authenticated
  using (public.es_admin())
  with check (public.es_admin());

create policy "shared_data · baja admin"
  on public.shared_data for delete
  to authenticated
  using (public.es_admin());


-- ── 6. bond_price_snapshots — histórico de precios y TIR ───────────────────
-- Es el dato que no se puede reconstruir: si se corrompe, no hay API que
-- devuelva la TIR de un bono de hace tres meses.
-- Lectura pública (la pestaña Curvas la consulta sin login).
-- Escritura: admin o bot. No hay borrado desde el cliente.

alter table public.bond_price_snapshots enable row level security;

create policy "snapshots · lectura pública"
  on public.bond_price_snapshots for select
  to anon, authenticated
  using (true);

create policy "snapshots · alta admin o bot"
  on public.bond_price_snapshots for insert
  to authenticated
  with check (public.puede_escribir_snapshots());

create policy "snapshots · modificación admin o bot"
  on public.bond_price_snapshots for update
  to authenticated
  using (public.puede_escribir_snapshots())
  with check (public.puede_escribir_snapshots());


-- ── 7. user_data — configuración por usuario ───────────────────────────────
-- Cada uno ve y escribe solamente sus propias filas.

alter table public.user_data enable row level security;

create policy "user_data · propio"
  on public.user_data for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ── 8. Verificación ────────────────────────────────────────────────────────
-- Correr después. Las tres tablas deben tener rowsecurity = true.

select
  c.relname                                as tabla,
  c.relrowsecurity                         as rls_activo,
  count(p.policyname)                      as politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
where n.nspname = 'public'
  and c.relname in ('shared_data','bond_price_snapshots','user_data','app_roles')
group by c.relname, c.relrowsecurity
order by c.relname;

-- Y esto debe devolver las filas cargadas en el paso 2:
select r.role, r.nota, u.email
from public.app_roles r
join auth.users u on u.id = r.user_id
order by r.role;
