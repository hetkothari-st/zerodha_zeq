-- Dev-only: opens sign-up during development by auto-approving new profiles,
-- so anyone can sign up and sign in while the mobile-verification step is on
-- hold behind the REQUIRE_MOBILE flag (see server/config.js, src/auth/core/featureFlags.js).
--
-- To revert before going live, run:
--   alter table public.profiles alter column status set default 'pending';
alter table public.profiles alter column status set default 'approved';
