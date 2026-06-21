import pg from "pg";

const client = new pg.Client({
  connectionString: "postgresql://postgres:w8t1xuGCpGdzFliN@db.hpwbugplcmqozghqgaah.supabase.co:5432/postgres"
});

await client.connect();

const result = await client.query(
  `SELECT id, status, last_error, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 10`
);

console.log("Recent jobs:");
result.rows.forEach((job) => {
  console.log(`  ${job.id}: ${job.status}`);
  if (job.last_error) {
    console.log(`    Error: ${job.last_error}`);
  }
  const created = new Date(job.created_at).toISOString();
  const updated = new Date(job.updated_at).toISOString();
  console.log(`    Created: ${created}, Updated: ${updated}`);
});

await client.end();
