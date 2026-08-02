import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

export interface ApiKeyRow {
  id: string;
  team_id: string;
  label: string;
  key_hash: string;
  key_prefix: string;
  revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const raw = randomBytes(32);
  const key = "zypp_" + Buffer.from(raw).toString("base64url");
  const prefix = key.slice(0, 12);
  return { key, prefix, keyHash: hashApiKey(key) };
}

export async function createApiKey(
  supabase: SupabaseClient,
  teamId: string,
  label: string,
): Promise<{ id: string; label: string; key: string }> {
  const { key, prefix, keyHash } = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert([{ team_id: teamId, label, key_hash: keyHash, key_prefix: prefix }])
    .select("id, label")
    .single();
  if (error || !data) throw new Error("Failed to create API key: " + error?.message);
  return { id: data.id, label: data.label, key };
}

export async function listApiKeys(supabase: SupabaseClient, teamId: string): Promise<ApiKeyRow[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ApiKeyRow[];
}

export async function revokeApiKey(supabase: SupabaseClient, id: string, teamId: string): Promise<void> {
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked: true })
    .eq("id", id)
    .eq("team_id", teamId);
  if (error) throw error;
}

export async function findTeamByApiKey(supabase: SupabaseClient, key: string): Promise<{ teamId: string } | null> {
  const keyHash = hashApiKey(key);
  const { data, error } = await supabase
    .from("api_keys")
    .select("team_id")
    .eq("key_hash", keyHash)
    .eq("revoked", false)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { teamId: data.team_id };
}

export async function touchApiKey(supabase: SupabaseClient, key: string): Promise<void> {
  const keyHash = hashApiKey(key);
  const { error } = await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash);
  if (error) throw error;
}
