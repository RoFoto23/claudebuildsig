-- Close a gap found by Supabase's security advisor (2026-10-18).
-- join_waitlist and log_event were executable by the public "anon" key through /rest/v1/rpc/..., which would let anyone
-- bypass the site's rate limits and bot checks and fill the waitlist and events tables. The app only calls them
-- server-side with the secret (service_role) key, so nothing legitimate needs anon or authenticated access.
revoke execute on function public.join_waitlist(text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.log_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.join_waitlist(text, text, text, boolean, text) to service_role;
grant execute on function public.log_event(text, text, jsonb) to service_role;
