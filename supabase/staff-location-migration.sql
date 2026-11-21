-- Extend the existing Pharmflow branches and profiles for Nance Oro Dental staff access.
-- Existing pharmacy records and relationships are left unchanged.

alter type public.app_role add value if not exists 'DENTAL_STAFF';

alter table public.branches
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists radius_meters integer not null default 100;

alter table public.branches alter column radius_meters set default 100;
alter table public.branches
  drop constraint if exists branches_geofence_coordinates_check;
update public.branches
set radius_meters = 100
where radius_meters is distinct from 100;

alter table public.profiles
  add column if not exists employee_code text,
  add column if not exists active boolean not null default true;

create unique index if not exists profiles_employee_code_unique
  on public.profiles (upper(employee_code))
  where employee_code is not null;

create table if not exists public.staff_signins (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid references public.profiles(id) on delete set null,
  employee_code text not null,
  employee_name text not null,
  branch_id uuid references public.branches(id) on delete set null,
  branch_name text not null,
  distance_meters numeric(7,2) not null check (distance_meters >= 0 and distance_meters <= 100),
  location_accuracy_meters numeric(7,2) not null check (location_accuracy_meters > 0 and location_accuracy_meters <= 100),
  created_at timestamptz not null default now()
);

create index if not exists staff_signins_created_at_idx
  on public.staff_signins (created_at desc);
create index if not exists staff_signins_employee_idx
  on public.staff_signins (employee_code, created_at desc);

alter table public.staff_signins
  drop constraint if exists staff_signins_distance_meters_check;
alter table public.staff_signins
  add constraint staff_signins_distance_meters_check
  check (distance_meters >= 0 and distance_meters <= 100);

alter table public.staff_signins enable row level security;
revoke all on public.staff_signins from anon, authenticated;
grant all on public.staff_signins to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['branches', 'medicines', 'batches', 'stock_movements', 'sales', 'sale_items']
  loop
    execute format('drop policy if exists "exclude dental staff" on public.%I', table_name);
    execute format(
      'create policy "exclude dental staff" on public.%I as restrictive for all to authenticated using (coalesce(auth.jwt()->''app_metadata''->>''app_access'', '''') <> ''dental_staff'') with check (coalesce(auth.jwt()->''app_metadata''->>''app_access'', '''') <> ''dental_staff'')',
      table_name
    );
  end loop;
end
$$;

alter table public.branches
  add constraint branches_geofence_coordinates_check
  check (
    radius_meters = 100
    and (
      (latitude is null and longitude is null)
      or (
        latitude is not null
        and longitude is not null
        and latitude between -90 and 90
        and longitude between -180 and 180
      )
    )
  );
