// hik-webhook — receives access/alarm event pushes from Hik-Connect for Teams
// and stores them. Keeps the FULL raw payload (so we can see the real field
// names on the first live event) plus a best-effort extraction of the fields
// we care about: person name, code, event time, door, event type.
//
// Inserts use the service-role key (auto-provided to Edge Functions), so it
// works even though the table is locked to authenticated reads.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Recursively find the first value whose key matches any candidate (case-insensitive).
function deepFind(obj: unknown, keys: string[]): string | null {
  const want = keys.map((k) => k.toLowerCase());
  const seen = new Set<unknown>();
  const stack: unknown[] = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (want.includes(k.toLowerCase()) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
        return String(v);
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

async function store(row: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/hik_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

Deno.serve(async (req) => {
  // Health check / browser hit
  if (req.method === "GET") return new Response("hik-webhook alive", { status: 200 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = { _nonjson: await req.text() };
  }

  const row = {
    person_name: deepFind(raw, ["personName", "name", "employeeName", "personNameEn", "cardHolderName"]),
    person_code: deepFind(raw, ["personCode", "employeeNo", "cardNo", "personId", "employeeNoString"]),
    event_time: deepFind(raw, ["happenTime", "dateTime", "eventTime", "time", "occurTime", "triggerTime", "date"]),
    door_name: deepFind(raw, ["doorName", "srcName", "deviceName", "resourceName", "acsDeviceName"]),
    event_type: deepFind(raw, ["eventType", "subEventType", "alarmType", "majorType", "subType"]),
    raw,
  };

  try {
    await store(row);
  } catch (_e) {
    // Never fail the push back to Hik — always 200 so it doesn't retry-storm.
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
