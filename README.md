# The Blitz of Bravery

A web app for a season-long football confidence pool that I run with about 70 friends. It replaced a spreadsheet and a group text. Players make weekly picks, the app pulls in live scores, and results are graded automatically.

**Live site:** https://blitzofbravery.com
**Built by:** Tim Flanigan

## The problem

Each week, an admin picks 11 NFL and college games plus a Monday Night tiebreaker. Every player picks a winner for each game and assigns confidence values from 1 to 10, each used once, so a correct pick is worth the points you gave it. Running that by hand meant manual grading, lost picks, disputes over who locked in when, and a lot of spreadsheet maintenance. This app automates the whole loop.

## What it does

- **Accounts and privacy:** Email and password sign-up, password reset, and per-player profiles. A player's picks stay private until the admin locks the week, then everyone can see them.
- **Weekly picks:** Winner selection, confidence values, a tiebreaker on the Monday game's combined score, and a once-per-season "Seau's Hammer" all-in mechanic.
- **Live scores and auto-grading:** Scores, records, spreads and AP rankings sync from ESPN. Finished games are graded and standings update without anyone touching a spreadsheet.
- **Standings and side pools:** Weekly and season leaderboards, plus 1-point and 10-point survivor boards.
- **Scenario tool:** Shows each player what outcomes in the remaining games would put them in the money.
- **Message board:** Weekly threads with replies, @mentions and media attachments.
- **Hall of Fame and schedule browser:** Past winners and an upcoming-games view.
- **Admin tools:** Build the weekly slate from a synced schedule, lock and unlock weeks, set payouts, create accounts for players, and edit picks on a player's behalf.
- **Insurance auto-fill:** If a registered player misses a lock, the system fills their picks automatically using a defined rule, so no one gets a zero.

## How it works

| Layer | Tech |
| --- | --- |
| Front end | Single-page app in vanilla JavaScript (`index.html`) |
| Database and auth | Supabase (Postgres and Auth) |
| Backend | Serverless functions in `api/`, hosted on Vercel |
| Scheduling | GitHub Actions cron |
| Data source | ESPN's public scoreboard and rankings endpoints |

**Sync flow**

1. `.github/workflows/sync-schedule.yml` calls the `sync-schedule` endpoint every 15 minutes on game days (Saturday through Monday) and every 6 hours the rest of the week. The request carries a bearer token.
2. `api/sync-schedule.js` fetches NFL and college scoreboards and AP rankings, refreshes the schedule cache the admin picks from, updates live scores, grades completed games, and applies the insurance rule.
3. `api/refresh-scores.js` is a lighter endpoint the app calls on load so scores feel live between cron runs.

**Engineering notes**

- ESPN's NFL endpoint returned stale "current week" data and rejected date ranges, so the sync fetches each day separately and merges the results.
- Games are matched by team names and a 36-hour kickoff window so a divisional rematch can't overwrite another week's score.
- Service credentials live in environment variables only. The browser uses Supabase's public anon key, with access limited by row-level security.

## Configuration

Vercel environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`
GitHub Actions secrets: `SYNC_URL`, `CRON_SECRET`

## Notes

Built with Claude as a development partner for code, debugging and iteration.
