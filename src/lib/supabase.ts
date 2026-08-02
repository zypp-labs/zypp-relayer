import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.NODE_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NODE_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
}

const supabase = createClient(url, key);

export default supabase;