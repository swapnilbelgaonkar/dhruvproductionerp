-- Employee details from the company staff list (Nov 2026). Employees are records for reporting lines, approval routing and later role
-- assignment; a sign-in (iam.users) is created separately and only when asked. Personal details (other phone numbers, education,
-- date of joining, ID card, blood group) are shown only to holders of org.employee:view_personal.
alter table org.employees
  add column if not exists serial_no         int,
  add column if not exists team              text,      -- the section of the staff list, e.g. "Nagpur A", "FACTORY"
  add column if not exists headquarters      text,
  add column if not exists district          text,
  add column if not exists area              text,
  add column if not exists reporting_to      text,      -- as written; manager_id holds the resolved employee
  add column if not exists phone_numbers     text,
  add column if not exists education         text,
  add column if not exists date_of_joining   date,
  add column if not exists date_of_joining_text text,   -- when the list gives something that is not a date
  add column if not exists id_card_no        text,
  add column if not exists blood_group       text check (blood_group is null or blood_group in ('A+','A-','B+','B-','AB+','AB-','O+','O-'));
