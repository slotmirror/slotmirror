#!/bin/zsh
# Gives the seeded dev user the state that the checks expect, through the app's own calendar save:
# working hours (Monday to Friday, 08:00 to 18:00) on sim-u-dev-1. New hours start on every running
# mirroring into that calendar, so sim-u-dev-2 to sim-u-dev-1 shows the working-hours switch (on)
# and the hours tag. `/dev/seed` sets no hours: without them the hours checks find no switch and
# the wide lists show no tag. The scripts put back what they change, so this runs once per seed.
# A second run changes nothing. Exits 1 if the state is not there afterwards.
# Usage: test/browser/setup.sh [base-url]     (default http://localhost:8822)
BASE=${1:-http://localhost:8822}

answer=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' -X POST "$BASE/calendars/sim-u-dev-1" \
  -d workHoursShown=1 -d workHoursOn=1 \
  -d workDays=1 -d workDays=2 -d workDays=3 -d workDays=4 -d workDays=5 \
  --data-urlencode workStart=08:00 --data-urlencode workEnd=18:00 \
  --data-urlencode workTimeZone=Europe/Vienna) || { print -u2 "setup: the server did not answer"; exit 1; }
# A save redirects (303) to the calendar with `saved=1`; a refusal answers 200, 400 or 409.
if [[ $answer != 303\ *saved=1* ]]; then
  print -u2 "setup: the calendar save was not stored: $answer"
  exit 1
fi

# The state itself: the calendar has hours and the mirroring's switch is there and on.
calendar=$(curl -fsS "$BASE/calendars?c=sim-u-dev-1") || exit 1
mirroring=$(curl -fsS "$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1") || exit 1
if ! grep -qE '<input[^>]*name="workHoursOn"[^>]* checked(=|[ />])' <<<"$calendar"; then
  print -u2 "setup: sim-u-dev-1 has no working hours after the save"
  exit 1
fi
if ! grep -qE '<input[^>]*name="workHours"[^>]* checked(=|[ />])' <<<"$mirroring"; then
  print -u2 "setup: the mirroring sim-u-dev-2 to sim-u-dev-1 has no working-hours switch that is on"
  exit 1
fi
print -r -- '{"setup":true,"calendar":"sim-u-dev-1","workHours":"1-5 08:00-18:00 Europe/Vienna"}'
