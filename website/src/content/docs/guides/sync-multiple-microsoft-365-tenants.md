---
title: Sync calendars across Microsoft 365 tenants
description: Keep the calendars of two companies or of client tenants in sync, so that nobody in either tenant books you twice.
sidebar:
  order: 3
---

You work in two Microsoft 365 tenants, for example as a founder of two companies or as a
consultant with a client account. Free/busy sharing between tenants needs an admin on both sides
and often does not exist. This guide syncs the calendars yourself, as busy blocks.

## Why not free/busy sharing between the tenants?

Microsoft 365 can share free/busy information between tenants. An admin of each tenant has to
set it up. The other tenant then sees your availability, but your own calendars still do not block
each other.

slotmirror needs no change in either tenant, unless a tenant limits user consent. It writes the
blocks into your calendar in each tenant, so free/busy lookups in each tenant see them.

## Steps

1. Create a [Microsoft Entra app](../../docs/entra-setup/) with the account type **Accounts in
   any organizational directory and personal Microsoft accounts**. A single-tenant app cannot
   connect the second tenant.
2. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and set `PUBLIC_URL`.
3. Connect one account per tenant on the **Calendars** page with **Connect calendar**. If a
   tenant blocks user consent, its admin must grant consent to the app once.
4. On the **Mirroring** page, choose **Mirror all as busy**. Each calendar then shows the events of
   the others as busy.

## Names of the calendars

slotmirror derives a short name from each address. You can rename a calendar, for example to the
name of the company, so that the **Mirroring** page reads "Company A to Company B". Open the panel
of the calendar on the **Calendars** page, set **Name** and choose **Save**.

## Things to know

- Each tenant sees only a private event, unless you choose more detail per mirroring.
- If you sign in with one of the tenants and want only that tenant to sign in, see
  [Organisations](../../docs/organisations/).

## Questions

### Do I need admin rights in each tenant?

Usually not. You connect your own account in each tenant. If a tenant blocks user consent, its
admin must grant consent to the app once. See [Microsoft Entra app](../../docs/entra-setup/).

### Can I connect more than two tenants?

Yes. Connect one calendar per tenant. **Mirror all as busy** on the **Mirroring** page then covers all of them.

### Does one client see the meetings of another client?

No, unless you choose more detail for that mirroring. By default each tenant sees only a private
event.

## Related guides

- [Sync Outlook and Google Calendar](../sync-outlook-and-google-calendar/)
- [Show your private calendar as busy at work](../show-private-calendar-as-busy-at-work/)
