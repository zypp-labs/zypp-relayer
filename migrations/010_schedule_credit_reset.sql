-- Schedule the monthly credit reset.
--
-- `reset_team_credits()` has existed since 006 and its own comment says "called
-- by cron monthly". Nothing called it. There was no pg_cron schedule in any
-- migration and no application caller — `resetMonthlyCredits()` in
-- src/store/teams.ts wraps the RPC but has zero call sites.
--
-- The consequence was not subtle: every team received its allocation exactly
-- once, at signup, forever. A free-tier team that spent its 100 credits entered
-- shunt mode permanently, with no path back that did not involve someone running
-- SQL by hand.
--
-- ## Why pg_cron rather than an application scheduler
--
-- The reset is a single UPDATE against the database with no application state
-- involved. Scheduling it in the database means it does not depend on the
-- relayer process being up, on a Render cron job being configured separately
-- from this repo, or on an HTTP endpoint that would then need its own
-- authentication. It also keeps the schedule in version control next to the
-- function it calls, which an external scheduler's dashboard config does not.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Make the reset safe to run more than once in a period.
--
-- The original function reset every team unconditionally: no WHERE clause, and
-- `credits_reset_at` was written but never read. That is fine exactly once a
-- month and wrong every other time — a scheduler that double-fires (pg_cron can,
-- around restarts and clock changes), a manual run to fix one team, or a replayed
-- migration would top every team back up to its limit mid-period and hand out
-- free credits.
--
-- Guarding on `credits_reset_at` makes the operation idempotent within a period,
-- which is the property anything scheduled needs: at-least-once delivery becomes
-- safe, so the schedule does not have to be exactly-once.
--
-- `date_trunc('month', now())` is the start of the current UTC month. A team
-- whose last reset is at or after that boundary has already been reset this
-- month and is skipped. NULL means never reset, which must proceed — a team
-- created before 006 added the column has no reset timestamp.
CREATE OR REPLACE FUNCTION reset_team_credits()
RETURNS void AS $$
BEGIN
  UPDATE teams
  SET credits_remaining = credits_limit, credits_reset_at = now(), updated_at = now()
  WHERE credits_reset_at IS NULL
     OR credits_reset_at < date_trunc('month', now());
END;
$$ LANGUAGE plpgsql;

-- Unschedule first so re-running this migration does not create a second
-- schedule for the same job. cron.unschedule throws if the job does not exist,
-- hence the existence check rather than a bare call.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reset-team-credits-monthly') THEN
    PERFORM cron.unschedule('reset-team-credits-monthly');
  END IF;
END;
$$;

-- 00:07 UTC on the 1st. Not midnight exactly: the top of the hour on the first
-- of the month is where every scheduled job in the world piles up, and the reset
-- has no deadline that a few minutes would violate.
SELECT cron.schedule(
  'reset-team-credits-monthly',
  '7 0 1 * *',
  $$SELECT reset_team_credits()$$
);

-- Verifying this actually runs, after applying:
--
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'reset-team-credits-monthly';
--
--   SELECT status, start_time, return_message
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job
--                    WHERE jobname = 'reset-team-credits-monthly')
--    ORDER BY start_time DESC LIMIT 5;
--
-- The second query is the one that matters. A schedule can exist and still fail
-- every run — the job runs as the migration's role, and if that role cannot
-- UPDATE teams the failure appears only here, silently, once a month.
