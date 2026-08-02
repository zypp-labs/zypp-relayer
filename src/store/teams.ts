import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../lib/logger.js";

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  plan_tier: string;
  polar_customer_id: string | null;
  polar_subscription_id: string | null;
  credits_limit: number;
  credits_remaining: number;
  credits_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getTeamById(supabase: SupabaseClient, id: string): Promise<TeamRow | null> {
  const { data, error } = await supabase.from("teams").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as TeamRow | null;
}

export async function getTeamByWallet(supabase: SupabaseClient, wallet: string): Promise<TeamRow | null> {
  const { data, error } = await supabase
    .from("users")
    .select("team_id")
    .eq("wallet_address", wallet)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return getTeamById(supabase, data.team_id);
}

export async function createTeam(supabase: SupabaseClient, log: Logger, wallet: string): Promise<TeamRow> {
  const { data: result, error } = await supabase
    .rpc("create_team_for_wallet", { p_wallet: wallet })
    .single();
  if (error) throw new Error("Failed to create team: " + error.message);
  const team = await getTeamById(supabase, (result as any).team_id as string);
  if (!team) throw new Error("Team created but not found");
  log.info({ teamId: team.id, wallet }, "Team created with 100 credits");
  return team;
}

export async function deductCredit(supabase: SupabaseClient, log: Logger, teamId: string): Promise<boolean> {
  const { data, error } = await supabase
    .rpc("deduct_team_credit", { p_team_id: teamId })
    .single();
  if (error) throw error;
  if (data === false) {
    log.warn({ teamId }, "Credit deduction failed — team may be exhausted");
  }
  return data === true;
}

export async function getTeamUsage(supabase: SupabaseClient, teamId: string): Promise<{ current: number; limit: number; degraded: boolean }> {
  const team = await getTeamById(supabase, teamId);
  if (!team) throw new Error("Team not found");
  const current = team.credits_limit - team.credits_remaining;
  const degraded = team.credits_remaining <= 0;
  return { current, limit: team.credits_limit, degraded };
}

export async function resetMonthlyCredits(supabase: SupabaseClient, log: Logger): Promise<void> {
  const { error } = await supabase.rpc("reset_team_credits");
  if (error) throw error;
  log.info("Monthly credits reset applied");
}
