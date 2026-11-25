-- Dealer list import (Nov 2026): like vendors, a dealer can be recorded as a Draft with only what is known. Category, territory and
-- sales owner may be empty until onboarding; the onboarding checklist requires them (and the KYC details) before submission.
alter table mdm.dealer_profiles alter column dealer_category drop not null, alter column territory_id drop not null, alter column sales_owner_id drop not null;
