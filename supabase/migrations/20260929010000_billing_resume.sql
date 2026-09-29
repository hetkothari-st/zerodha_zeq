-- Resume Pro after cancelling. A cancel (cancel_at_cycle_end) keeps the subscription row
-- 'active' with cancel_at_period_end=true until the paid period ends — that's how the user
-- keeps Pro through the period they already paid for. The original one-open-subscription-per-user
-- index treated that row as "open" and blocked starting a new one, so there was no way to undo
-- a cancel. Redefine the index to ignore rows already scheduled to cancel: a second, later
-- subscription may now be created for the same user, to take over once the old one lapses.
drop index public.subscriptions_one_open_per_user;
create unique index subscriptions_one_open_per_user on public.subscriptions (user_id)
    where status in ('created', 'authenticated', 'active', 'pending') and not cancel_at_period_end;
