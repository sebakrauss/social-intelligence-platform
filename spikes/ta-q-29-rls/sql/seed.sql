-- DISPOSABLE SPIKE SEED — synthetic data only. Run as the bootstrap superuser (bypasses RLS for seeding).
-- Organization A: workspaces A1, A2.  Organization B: workspace B1.
insert into public.organizations values
  ('0a000000-0000-0000-0000-000000000000', 'Org A (synthetic)'),
  ('0b000000-0000-0000-0000-000000000000', 'Org B (synthetic)');
insert into public.workspaces values
  ('a1000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000000', 'A1'),
  ('a2000000-0000-0000-0000-000000000000', '0a000000-0000-0000-0000-000000000000', 'A2'),
  ('b1000000-0000-0000-0000-000000000000', '0b000000-0000-0000-0000-000000000000', 'B1');
-- Users: u_a1 (manager A1) · u_a12 (responder A1 + manager A2) · u_b1 (manager B1) · u_guest (client_guest A1) · u_none (no memberships)
insert into public.memberships values
  ('11111111-0000-0000-0000-0000000000a1', 'a1000000-0000-0000-0000-000000000000', 'manager'),
  ('11111111-0000-0000-0000-000000000a12', 'a1000000-0000-0000-0000-000000000000', 'responder'),
  ('11111111-0000-0000-0000-000000000a12', 'a2000000-0000-0000-0000-000000000000', 'manager'),
  ('11111111-0000-0000-0000-0000000000b1', 'b1000000-0000-0000-0000-000000000000', 'manager'),
  ('11111111-0000-0000-0000-0000000000ee', 'a1000000-0000-0000-0000-000000000000', 'client_guest');
insert into public.conversations
  select ('c' || ws_tag || '00000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, ws, 'synthetic conversation ' || n
  from (values ('a1', 'a1000000-0000-0000-0000-000000000000'::uuid),
               ('a2', 'a2000000-0000-0000-0000-000000000000'::uuid),
               ('b1', 'b1000000-0000-0000-0000-000000000000'::uuid)) w(ws_tag, ws),
       generate_series(1, 3) n;
insert into public.interactions
  select ('d' || ws_tag || '00000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, ws,
         ('c' || ws_tag || '00000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'synthetic comment ' || n
  from (values ('a1', 'a1000000-0000-0000-0000-000000000000'::uuid),
               ('a2', 'a2000000-0000-0000-0000-000000000000'::uuid),
               ('b1', 'b1000000-0000-0000-0000-000000000000'::uuid)) w(ws_tag, ws),
       generate_series(1, 3) n;
insert into public.guest_insights values
  ('e1000000-0000-0000-0000-0000000000a1', 'a1000000-0000-0000-0000-000000000000', 'guest-safe insight A1'),
  ('e1000000-0000-0000-0000-0000000000b1', 'b1000000-0000-0000-0000-000000000000', 'guest-safe insight B1');
insert into public.attention_signals values
  ('a1000000-0000-0000-0000-000000000000', true),
  ('a2000000-0000-0000-0000-000000000000', false),
  ('b1000000-0000-0000-0000-000000000000', true);
insert into system.outbox_meta values ('f0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000000', 'pending');
insert into system.asset_routing values ('page:synthetic-1', 'a1000000-0000-0000-0000-000000000000');
