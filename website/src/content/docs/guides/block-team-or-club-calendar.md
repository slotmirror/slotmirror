---
title: Block time for a team or club schedule
description: Turn a subscribed team, club or school calendar into busy blocks in your work calendar, so that matches and training are never double-booked.
sidebar:
  order: 4
---

Your club, team or school publishes a schedule, and you subscribe to it in Google Calendar or
Outlook. Your work calendar does not know about it. This guide blocks every entry of that
schedule in your other calendars.

## Why the subscription alone does not block your time

A subscribed calendar shows the schedule to you. People who check when you are free see your main
calendar, so a match on Saturday does not stop a colleague from booking you. slotmirror reads the
subscribed calendar and writes a block for each entry into the main calendar of your other
accounts.

Google Calendar and Outlook refresh a subscribed calendar on their own schedule. slotmirror sees a
change in the schedule only after that refresh.

## Steps

1. Subscribe to the schedule in the account where you already have it, for example Google
   Calendar.
2. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and connect that account and
   your work account.
3. On the **Calendars** page, open the panel of the account with the schedule.
4. Under **Copy from these calendars**, turn on the schedule next to the calendar marked **Main**,
   and choose **Save**.
5. On the **Mirroring** page, open the row from that account to your work calendar. Keep **Busy
   only** under **What is copied**, or choose **Title** if colleagues may see "Home match". If you
   choose **Title**, set **What others see** to **Same as you**.
6. Choose **Save**. If nothing is mirrored yet, choose **Mirror all as busy** first.

## Things to know

- The schedule is a source only. Copies go into the main calendar of each target account.
- **Skip all-day events** is off by default, so all-day entries such as tournament days block the
  whole day. Entries that are marked as free stay out. To leave out all all-day entries, turn the
  setting on under **For all mirrorings** on the **Mirroring** page. The setting applies to all your calendars.

## Related guides

- [Show your private calendar as busy at work](../show-private-calendar-as-busy-at-work/)
- [Sync Outlook and Google Calendar](../sync-outlook-and-google-calendar/)
