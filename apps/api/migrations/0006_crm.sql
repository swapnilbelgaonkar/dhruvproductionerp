-- Stage 2 part 2 — CRM: leads, BANT, opportunities, activities (BRD §4 sub-modules 1–5; MP §7.1–7.5; CRM-003…008)
create schema if not exists sales;

create table sales.leads (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  company          text not null,
  contact_person   text not null,
  mobile           text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  email            citext,
  source           text not null check (source in ('EXHIBITION','INDIAMART','FIELD_VISIT','REFERRAL','DEALER_ENQUIRY','WEBSITE','OTHER')),
  source_detail    text,
  territory_id     uuid not null references org.territories (id),
  owner_id         uuid not null references org.employees (id),
  product_interest text not null,
  expected_qty     numeric(18,4) check (expected_qty >= 0),
  expected_uom     text references mdm.uom (code),
  status           text not null default 'New' check (status in ('New','Contacted','Qualified','Disqualified','Converted')),
  -- BANT (BRD §4 #3): budget, authority, need, timeline
  bant_budget      boolean,
  bant_authority   boolean,
  decision_maker   text,
  bant_need_score  int check (bant_need_score between 1 and 5),
  bant_timeline    date,
  bant_score       int,
  disqualify_reason text,
  follow_up_at     timestamptz,
  party_id         uuid references mdm.parties (id),
  opportunity_id   uuid,
  notes            text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index leads_mobile_idx on sales.leads (mobile);
create index leads_owner_idx on sales.leads (owner_id, status);
create index leads_territory_idx on sales.leads (territory_id);

create table sales.opportunities (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  lead_id          uuid references sales.leads (id),
  party_id         uuid references mdm.parties (id),
  company          text not null,
  title            text not null,
  territory_id     uuid not null references org.territories (id),
  owner_id         uuid not null references org.employees (id),
  stage            text not null default 'REQUIREMENT' check (stage in ('REQUIREMENT','SAMPLE_TRIAL','QUOTE_SENT','PO_EXPECTED','WON','LOST')),
  value            numeric(18,2) not null default 0 check (value >= 0),
  probability      int not null default 10 check (probability between 0 and 100),
  expected_close   date,
  product_interest text,
  loss_reason      text check (loss_reason in ('PRICE','COMPETITOR','NO_BUDGET','NO_NEED','TIMING','PRODUCT_FIT','NO_RESPONSE','OTHER')),
  loss_notes       text,
  closed_at        timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (stage <> 'LOST' or loss_reason is not null),
  check (stage <> 'WON' or party_id is not null)
);
create index opportunities_owner_idx on sales.opportunities (owner_id, stage);
create index opportunities_territory_idx on sales.opportunities (territory_id);
alter table sales.leads add constraint leads_opportunity_fk foreign key (opportunity_id) references sales.opportunities (id);

create table sales.opportunity_stage_history (
  id             bigserial primary key,
  opportunity_id uuid not null references sales.opportunities (id),
  from_stage     text,
  to_stage       text not null,
  value          numeric(18,2) not null,
  changed_by     uuid references iam.users (id),
  changed_at     timestamptz not null default now(),
  note           text
);
create trigger opp_history_append_only before update or delete on sales.opportunity_stage_history for each row execute function sys.deny_modify();

create table sales.activities (
  id             uuid primary key default gen_random_uuid(),
  subject_type   text not null check (subject_type in ('lead','opportunity','dealer')),
  subject_id     uuid not null,
  kind           text not null check (kind in ('CALL','MEETING','DEALER_VISIT','FIELD_VISIT','AGRONOMIST','FOLLOW_UP','TASK')),
  title          text not null,
  notes          text,
  owner_id       uuid not null references org.employees (id),
  territory_id   uuid not null references org.territories (id),
  planned_at     timestamptz not null,
  done_at        timestamptz,
  outcome        text,
  status         text not null default 'Planned' check (status in ('Planned','Done','Cancelled')),
  latitude       numeric(9,6) check (latitude between -90 and 90),
  longitude      numeric(9,6) check (longitude between -180 and 180),
  created_at timestamptz not null default now(), created_by uuid,
  check (status <> 'Done' or (done_at is not null and outcome is not null))
);
create index activities_subject_idx on sales.activities (subject_type, subject_id);
create index activities_owner_due_idx on sales.activities (owner_id, planned_at) where status = 'Planned';

do $$
declare t text;
begin
  foreach t in array array['sales.leads','sales.opportunities'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('LEAD_CODE', 'LEAD', 5, 'Lead code LEAD-2026-00001'),
  ('OPP_CODE', 'OPP', 5, 'Opportunity code OPP-2026-00001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('crm.bant.qualifyScore', '60', 'Minimum BANT score (0–100) to qualify a lead'),
  ('crm.stageProbability', '{"REQUIREMENT":10,"SAMPLE_TRIAL":25,"QUOTE_SENT":50,"PO_EXPECTED":75,"WON":100,"LOST":0}', 'Default win probability per opportunity stage')
on conflict (key) do nothing;
