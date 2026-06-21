const { createClient } = require("@supabase/supabase-js");

const relayerSupabase = createClient(
  "https://hpwbugplcmqozghqgaah.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhwd2J1Z3BsY21xb3pnaHFnYWFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDk0MzAwOTUsImV4cCI6MTkyNTAwNjA5NX0.Tb7HE8XSx4lBdvJqH1gVMjpCXPCb-KE0qKqF0yZjxjE"
);

async function checkJobs() {
  const { data, error } = await relayerSupabase
    .from("jobs")
    .select("id, status, last_error, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error:", error);
    return;
  }

  console.log("Recent jobs:");
  data?.forEach((job) => {
    console.log(`  ${job.id}: ${job.status}`);
    if (job.last_error) {
      console.log(`    Error: ${job.last_error}`);
    }
    console.log(`    Created: ${job.created_at}, Updated: ${job.updated_at}`);
  });
}

checkJobs().catch(console.error);
