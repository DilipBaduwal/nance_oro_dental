begin;

alter table public.branches
  alter column radius_meters set default 100,
  drop constraint if exists branches_geofence_coordinates_check;

update public.branches
set radius_meters = 100
where radius_meters is distinct from 100;

alter table public.staff_signins
  drop constraint if exists staff_signins_distance_meters_check;
alter table public.staff_signins
  add constraint staff_signins_distance_meters_check
  check (distance_meters >= 0 and distance_meters <= 100);

alter table public.staff_signins
  drop constraint if exists staff_signins_location_accuracy_meters_check;
alter table public.staff_signins
  add constraint staff_signins_location_accuracy_meters_check
  check (location_accuracy_meters > 0 and location_accuracy_meters <= 100);

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

commit;
