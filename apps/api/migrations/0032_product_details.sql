-- Product catalogue details from the company product list (Nov 2026): agronomy and label content kept on the item master.
-- Base unit and pack container may be left empty while an item is a Draft, so a product can be loaded with only what is known
-- and completed before it is submitted for approval.
alter table mdm.items
  add column if not exists active_ingredient text,
  add column if not exists composition       text,
  add column if not exists key_benefits      text,
  add column if not exists advisory_dosage   text,
  add column if not exists fco_grade         text,     -- as marked in the brochure: Yes / CIB
  add column if not exists brochure_page     int check (brochure_page is null or brochure_page > 0),
  alter column base_uom drop not null;
alter table mdm.items add constraint items_base_uom_chk check (base_uom is not null or status in ('Draft', 'Rejected'));
alter table mdm.item_packs alter column container drop not null;
