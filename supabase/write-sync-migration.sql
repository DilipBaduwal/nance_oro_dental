-- Writable supplier, purchase, inventory-receipt, and billing support using
-- the existing pharmacy tables. Mutating functions are server-only.

create table if not exists public.suppliers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  contact_name text,
  phone text,
  email text,
  brands text,
  categories text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists suppliers_name_unique
  on public.suppliers (lower(name));

create table if not exists public.purchases (
  id uuid primary key default uuid_generate_v4(),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id),
  invoice_number text unique not null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  tax numeric(12,2) not null default 0 check (tax >= 0),
  total numeric(12,2) not null check (total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_items (
  id uuid primary key default uuid_generate_v4(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id),
  batch_id uuid references public.batches(id),
  quantity integer not null check (quantity > 0),
  boxes integer not null default 0 check (boxes >= 0),
  strips integer not null default 0 check (strips >= 0),
  pieces integer not null default 0 check (pieces >= 0),
  strips_per_box integer not null default 10 check (strips_per_box > 0),
  pieces_per_strip integer not null default 10 check (pieces_per_strip > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0),
  line_total numeric(12,2) not null check (line_total >= 0)
);

alter table public.sale_items alter column batch_id drop not null;

create table if not exists public.legacy_imports (
  source_key text primary key,
  source_type text not null,
  target_id uuid,
  record jsonb not null,
  imported_at timestamptz not null default now()
);

alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.legacy_imports enable row level security;
revoke all on public.suppliers, public.purchases, public.purchase_items, public.legacy_imports from anon, authenticated;
grant all on public.suppliers, public.purchases, public.purchase_items, public.legacy_imports to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['suppliers', 'purchases', 'purchase_items', 'legacy_imports']
  loop
    execute format('drop policy if exists "exclude dental staff" on public.%I', table_name);
    execute format(
      'create policy "exclude dental staff" on public.%I as restrictive for all to authenticated using (coalesce(auth.jwt()->''app_metadata''->>''app_access'', '''') <> ''dental_staff'') with check (coalesce(auth.jwt()->''app_metadata''->>''app_access'', '''') <> ''dental_staff'')',
      table_name
    );
  end loop;
end
$$;

create or replace function public.receive_purchase(
  p_branch_id uuid,
  p_supplier_id uuid,
  p_medicine_name text,
  p_generic_name text,
  p_quantity integer,
  p_unit_cost numeric,
  p_tax_rate numeric,
  p_selling_price numeric,
  p_expiry_date date,
  p_batch_number text,
  p_boxes integer default 0,
  p_strips integer default 0,
  p_pieces integer default 0,
  p_strips_per_box integer default 10,
  p_pieces_per_strip integer default 10
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_medicine public.medicines%rowtype;
  v_batch public.batches%rowtype;
  v_purchase_id uuid;
  v_invoice text;
  v_subtotal numeric(12,2);
  v_tax numeric(12,2);
  v_total numeric(12,2);
  v_batch_number text;
begin
  if p_quantity < 1 or p_quantity > 1000000
    or p_unit_cost < 0 or p_tax_rate < 0 or p_tax_rate > 100
    or p_selling_price < 0 or p_expiry_date is null or p_expiry_date < current_date
    or p_medicine_name is null or length(trim(p_medicine_name)) = 0
    or p_boxes < 0 or p_strips < 0 or p_pieces < 0
    or p_strips_per_box < 1 or p_pieces_per_strip < 1 then
    raise exception 'Invalid purchase details';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and status = 'ACTIVE')
    or not exists (select 1 from public.suppliers where id = p_supplier_id and active) then
    raise exception 'Select an active branch and supplier';
  end if;

  perform pg_advisory_xact_lock(hashtext(lower(trim(p_medicine_name))));
  select * into v_medicine
  from public.medicines
  where lower(name) = lower(trim(p_medicine_name))
  order by created_at
  limit 1
  for update;

  if not found then
    insert into public.medicines (name, generic_name, status)
    values (trim(p_medicine_name), nullif(trim(coalesce(p_generic_name, '')), ''), 'ACTIVE')
    returning * into v_medicine;
  elsif nullif(trim(coalesce(p_generic_name, '')), '') is not null then
    update public.medicines
    set generic_name = nullif(trim(p_generic_name), '')
    where id = v_medicine.id
    returning * into v_medicine;
  end if;

  v_subtotal := round(p_quantity * p_unit_cost, 2);
  v_tax := round(v_subtotal * p_tax_rate / 100, 2);
  v_total := v_subtotal + v_tax;
  v_invoice := 'PO-' || upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 12));
  v_batch_number := coalesce(nullif(trim(p_batch_number), ''), 'RCV-' || upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 12)));

  insert into public.purchases (branch_id, supplier_id, invoice_number, subtotal, tax, total)
  values (p_branch_id, p_supplier_id, v_invoice, v_subtotal, v_tax, v_total)
  returning id into v_purchase_id;

  insert into public.batches (
    medicine_id, branch_id, batch_number, expiry_date, purchase_price, mrp,
    selling_price, received_quantity, available_quantity, status
  ) values (
    v_medicine.id, p_branch_id, v_batch_number, p_expiry_date, p_unit_cost,
    p_selling_price, p_selling_price, p_quantity, p_quantity, 'AVAILABLE'
  ) returning * into v_batch;

  insert into public.purchase_items (
    purchase_id, medicine_id, batch_id, quantity, boxes, strips, pieces,
    strips_per_box, pieces_per_strip, unit_cost, tax_rate, line_total
  ) values (
    v_purchase_id, v_medicine.id, v_batch.id, p_quantity, p_boxes, p_strips, p_pieces,
    p_strips_per_box, p_pieces_per_strip, p_unit_cost, p_tax_rate, v_total
  );

  insert into public.stock_movements (batch_id, branch_id, type, quantity, reference_id, note)
  values (v_batch.id, p_branch_id, 'PURCHASE', p_quantity, v_purchase_id, 'Purchase ' || v_invoice);

  return jsonb_build_object(
    'id', v_purchase_id,
    'invoice_number', v_invoice,
    'supplier_id', p_supplier_id,
    'medicine_id', v_medicine.id,
    'batch_id', v_batch.id,
    'quantity', p_quantity,
    'subtotal', v_subtotal,
    'tax', v_tax,
    'total', v_total,
    'created_at', now()
  );
end
$$;

create or replace function public.record_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_payment_reference text default null,
  p_customer_name text default null,
  p_customer_mobile text default null,
  p_discount numeric default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_medicine public.medicines%rowtype;
  v_batch public.batches%rowtype;
  v_sale_id uuid;
  v_invoice text;
  v_quantity integer;
  v_remaining integer;
  v_take integer;
  v_subtotal numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_total numeric(12,2);
  v_discount numeric(12,2);
  v_line_price numeric(12,2);
  v_line_tax numeric(12,2);
  v_lines jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Sale items must be a non-empty array';
  end if;
  if jsonb_array_length(p_items) = 0
    or coalesce(p_payment_method, '') not in ('Cash', 'UPI', 'Card')
    or coalesce(p_discount, 0) < 0 then
    raise exception 'Invalid sale details';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and status = 'ACTIVE') then
    raise exception 'Select an active branch';
  end if;

  v_invoice := 'INV-' || upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 12));
  v_sale_id := uuid_generate_v4();

  insert into public.sales (
    id, branch_id, invoice_number, customer_name, customer_mobile, subtotal, discount,
    tax, total, payment_method, payment_reference, status
  ) values (
    v_sale_id, p_branch_id, v_invoice, nullif(trim(coalesce(p_customer_name, '')), ''),
    nullif(trim(coalesce(p_customer_mobile, '')), ''), 0, 0, 0, 0,
    p_payment_method, nullif(trim(coalesce(p_payment_reference, '')), ''), 'COMPLETED'
  );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity < 1 or v_quantity > 10000 then
      raise exception 'Invalid sale quantity';
    end if;
    select * into v_medicine
    from public.medicines
    where lower(name) = lower(trim(v_item->>'name')) and status = 'ACTIVE'
    order by created_at
    limit 1;
    if not found then
      raise exception 'Medicine not found: %', v_item->>'name';
    end if;

    v_remaining := v_quantity;
    for v_batch in
      select * from public.batches
      where medicine_id = v_medicine.id and branch_id = p_branch_id
        and status = 'AVAILABLE' and available_quantity > 0 and expiry_date >= current_date
      order by expiry_date
      for update
    loop
      exit when v_remaining = 0;
      v_take := least(v_remaining, v_batch.available_quantity);
      v_line_price := v_batch.selling_price;
      v_line_tax := round(v_take * v_line_price * coalesce(v_medicine.gst_rate, 0) / 100, 2);
      v_subtotal := v_subtotal + v_take * v_line_price;
      v_tax := v_tax + v_line_tax;
      v_remaining := v_remaining - v_take;
      update public.batches
      set available_quantity = available_quantity - v_take,
          status = case when available_quantity - v_take = 0 then 'OUT_OF_STOCK' else 'AVAILABLE' end
      where id = v_batch.id;
      insert into public.sale_items (sale_id, medicine_id, batch_id, quantity, unit_price, gst_rate)
      values (v_sale_id, v_medicine.id, v_batch.id, v_take, v_line_price, coalesce(v_medicine.gst_rate, 0));
      insert into public.stock_movements (batch_id, branch_id, type, quantity, reference_id, note)
      values (v_batch.id, p_branch_id, 'SALE', -v_take, v_sale_id, 'Sale ' || v_invoice);
    end loop;

    if v_remaining > 0 then
      raise exception 'Insufficient stock for %', v_medicine.name;
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('name', v_medicine.name, 'quantity', v_quantity));
  end loop;

  v_discount := round(coalesce(p_discount, 0), 2);
  if v_discount > v_subtotal then
    raise exception 'Discount cannot exceed the sale subtotal';
  end if;
  v_total := v_subtotal - v_discount + v_tax;

  update public.sales
  set subtotal = v_subtotal, discount = v_discount, tax = v_tax, total = v_total
  where id = v_sale_id;

  return jsonb_build_object(
    'id', v_sale_id, 'invoice_number', v_invoice, 'subtotal', v_subtotal,
    'discount', v_discount, 'tax', v_tax, 'total', v_total,
    'payment_method', p_payment_method, 'status', 'COMPLETED',
    'created_at', now(), 'items', v_lines
  );
end
$$;

revoke all on function public.receive_purchase(uuid, uuid, text, text, integer, numeric, numeric, numeric, date, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.record_sale(uuid, jsonb, text, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.receive_purchase(uuid, uuid, text, text, integer, numeric, numeric, numeric, date, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.record_sale(uuid, jsonb, text, text, text, text, numeric) to service_role;
