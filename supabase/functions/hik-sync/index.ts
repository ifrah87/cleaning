// hik-sync — pulls the enrolled staff roster from HikCentral Connect
// (Hik-Connect for Teams). Holds the AppKey/AppSecret server-side; the
// browser never sees them. Returns a clean {personId, personCode, name} list.
//
// Interim scope: roster only (who is enrolled). The live "who came in + when"
// feed (access events) is push/subscription-based and comes in a later phase.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE = "https://ieu.hikcentralconnect.com";

async function getToken(appKey: string, secretKey: string) {
  const r = await fetch(`${BASE}/api/hccgw/platform/v1/token/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, secretKey }),
  });
  const j = await r.json();
  if (j.errorCode !== "0" || !j.data?.accessToken) {
    throw new Error("Hik auth failed: " + JSON.stringify(j));
  }
  return { token: j.data.accessToken as string, base: (j.data.areaDomain as string) || BASE };
}

async function getPersons(base: string, token: string) {
  const persons: Array<{ personId: string; personCode: string; name: string }> = [];
  let pageIndex = 1;
  const pageSize = 100;
  while (pageIndex <= 50) {
    const r = await fetch(`${base}/api/hccgw/person/v1/persons/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": token },
      body: JSON.stringify({ pageIndex, pageSize }),
    });
    const j = await r.json();
    if (j.errorCode !== "0") throw new Error("Hik persons failed: " + JSON.stringify(j));
    const list = j.data?.personList ?? [];
    for (const p of list) {
      const info = p.personInfo ?? p;
      const name = `${info.firstName ?? ""} ${info.lastName ?? ""}`.trim();
      persons.push({
        personId: String(info.personId ?? ""),
        personCode: String(info.personCode ?? ""),
        name: name || `Person ${info.personCode ?? ""}`,
      });
    }
    const total = Number(j.data?.totalCount ?? persons.length);
    if (list.length < pageSize || persons.length >= total) break;
    pageIndex++;
  }
  return persons;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const appKey = Deno.env.get("HIK_APP_KEY");
    const secretKey = Deno.env.get("HIK_APP_SECRET");
    if (!appKey || !secretKey) throw new Error("HIK_APP_KEY / HIK_APP_SECRET not set");
    const { token, base } = await getToken(appKey, secretKey);
    const persons = await getPersons(base, token);
    return new Response(JSON.stringify({ ok: true, count: persons.length, persons }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
