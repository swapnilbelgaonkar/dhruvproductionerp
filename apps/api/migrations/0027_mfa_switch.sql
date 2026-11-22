-- Two-factor sign-in can be switched off for the pre-go-live demo and switched on again at go-live (Admin → Configuration).
insert into sys.settings (key, value, description) values
  ('auth.mfa.enforced', 'true', 'Two-factor sign-in (authenticator code) for roles that require it and for users who enrolled. Turn off only for demos; turn on before go-live.')
on conflict (key) do nothing;
