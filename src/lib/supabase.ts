import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.NODE_PUBLIC_SUPABASE_URL!,
  process.env.NODE_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
);

export default supabase;