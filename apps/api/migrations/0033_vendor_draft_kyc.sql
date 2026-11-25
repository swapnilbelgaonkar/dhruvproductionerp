-- Vendor list import (Nov 2026): a vendor can be recorded as a Draft with only what is known. KYC fields (constitution, PAN,
-- contact person, mobile, full registered address) may be empty until onboarding is completed; the onboarding checklist still
-- requires every one of them before the vendor can be submitted for approval. Dealers keep their stricter form.
alter table mdm.parties alter column constitution drop not null, alter column contact_person drop not null, alter column mobile drop not null,
  add column if not exists phone_numbers text;          -- every number as given (landlines, several mobiles); mobile holds the main one
alter table mdm.party_addresses alter column line1 drop not null, alter column city drop not null, alter column district drop not null,
  alter column state_code drop not null, alter column pincode drop not null;
