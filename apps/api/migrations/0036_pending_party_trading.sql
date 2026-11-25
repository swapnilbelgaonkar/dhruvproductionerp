-- Dealers and vendors loaded from the company lists are Drafts until their KYC is complete and approved. With this switch on, a dealer
-- or vendor that is Draft or Submitted can already be used in quotations, orders, invoices, receipts, requisitions, RFQs and purchase
-- orders; documents show "KYC pending". Rejected, Suspended and Inactive parties stay blocked, and statutory licence checks and the
-- verified bank account for paying a vendor still apply. Switch it off before go-live (the go-live checklist shows it).
insert into sys.settings (key, value, description) values
  ('parties.allowPendingKyc', 'true', 'Allow dealers and vendors whose onboarding (KYC) is not yet approved to be used in sales and purchase documents. Turn off before go-live.')
on conflict (key) do nothing;
