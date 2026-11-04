-- Per-Page bot on/off for the JMAG ops dashboard.
-- page_key 'sanpablo' is JMAG's Appliances. 'cavite' is Jmag's Appliances Cavite
-- (page id 1237499962773846, profile 61591823125793).
-- The bot reads with the Supabase service role, which bypasses RLS.
-- If a row is missing or the read fails, the bot stays silent for that Page.
-- Both rows start off. Re-running this file does not turn a Page back on.

create table if not exists public.bot_switches (
  page_key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint bot_switches_page_key_check check (page_key in ('sanpablo', 'cavite'))
);

insert into public.bot_switches (page_key, enabled)
values ('sanpablo', false), ('cavite', false)
on conflict (page_key) do nothing;

create or replace function public.bot_switches_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.page_key is distinct from old.page_key then
    raise exception 'page_key cannot be changed';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bot_switches_set_updated_at on public.bot_switches;
create trigger bot_switches_set_updated_at
  before update on public.bot_switches
  for each row
  execute function public.bot_switches_set_updated_at();

alter table public.bot_switches enable row level security;

revoke all on table public.bot_switches from public, anon;
grant select, update on table public.bot_switches to authenticated;

drop policy if exists bot_switches_select_authenticated on public.bot_switches;
create policy bot_switches_select_authenticated
  on public.bot_switches
  for select
  to authenticated
  using (true);

drop policy if exists bot_switches_update_authenticated on public.bot_switches;
create policy bot_switches_update_authenticated
  on public.bot_switches
  for update
  to authenticated
  using (true)
  with check (page_key in ('sanpablo', 'cavite') and enabled in (true, false));
