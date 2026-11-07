-- A product announcement is a source signal; a startup prospect is one company.
-- Exact website hostnames provide a conservative cross-source identity. Shared
-- publisher hosts are excluded and tenant subdomains are never collapsed.
create function public.startup_website_identity(website text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare matched text[]; hostname text;
begin
  matched := regexp_match(trim(website), '^https?://([^/?#:]+)(?::(?:80|443))?(?:[/?#]|$)', 'i');
  if matched is null then return null; end if;
  hostname := regexp_replace(regexp_replace(lower(matched[1]), '\.$', ''), '^www\.', '');
  if length(hostname) > 253
    or hostname !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
    or hostname ~ '^[0-9.]+$'
    or hostname = any(array[
      'github.com', 'gist.github.com', 'github.io', 'gitlab.com', 'bitbucket.org',
      'ycombinator.com', 'news.ycombinator.com', 'seedcamp.com', 'techstars.com', 'producthunt.com', 'medium.com',
      'substack.com', 'wordpress.com', 'blogspot.com', 'notion.so', 'notion.site',
      'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
      'apps.apple.com', 'play.google.com', 'youtube.com', 'youtu.be', 'linkedin.com',
      'facebook.com', 'x.com', 'twitter.com', 'itch.io', 'huggingface.co'
    ]) then return null;
  end if;
  return hostname;
end;
$$;
revoke all on function public.startup_website_identity(text) from public, anon;
grant execute on function public.startup_website_identity(text) to authenticated, service_role;

alter table public.opportunities add column startup_identity text;

-- Retain any historical duplicates with independent application/draft history.
-- The first saved prospect owns future imports; no records are deleted or
-- histories silently rewritten by this migration.
with identities as (
  select id, workspace_id,
    public.startup_website_identity(coalesce(nullif(payload->>'companyUrl', ''), payload->>'url')) as identity
  from public.opportunities
  where kind = 'startup' and coalesce(payload->'isDemo', 'false'::jsonb) <> 'true'::jsonb
), ranked as (
  select i.*, row_number() over (
    partition by i.workspace_id, i.identity
    order by o.payload->>'firstSeenAt', o.id
  ) as position
  from identities i join public.opportunities o on o.id = i.id
  where i.identity is not null
)
update public.opportunities o set startup_identity = ranked.identity
from ranked where ranked.id = o.id and ranked.position = 1;

create unique index opportunities_startup_identity
  on public.opportunities(workspace_id, startup_identity)
  where startup_identity is not null;

create function public.set_startup_identity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare identity text; previous_identity text;
begin
  identity := case when new.kind = 'startup' and coalesce(new.payload->'isDemo', 'false'::jsonb) <> 'true'::jsonb
    then public.startup_website_identity(coalesce(nullif(new.payload->>'companyUrl', ''), new.payload->>'url')) end;
  if tg_op = 'UPDATE' and old.startup_identity is null and old.kind = 'startup'
    and coalesce(old.payload->'isDemo', 'false'::jsonb) <> 'true'::jsonb then
    previous_identity := public.startup_website_identity(coalesce(nullif(old.payload->>'companyUrl', ''), old.payload->>'url'));
    -- Legacy duplicates remain editable without stealing the canonical claim.
    if identity is not distinct from previous_identity then identity := null; end if;
  end if;
  new.startup_identity := identity;
  if new.kind = 'startup' then new.updated_at := clock_timestamp(); end if;
  return new;
end;
$$;
revoke all on function public.set_startup_identity() from public, anon, authenticated;
create trigger opportunity_startup_identity before insert or update on public.opportunities
for each row execute function public.set_startup_identity();

notify pgrst, 'reload schema';
