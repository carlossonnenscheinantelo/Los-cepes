// asistente-los-cepes — chat con IA dentro de la app de la estancia Los Cepes.
// La app manda la conversación + un resumen de los datos; esta función verifica
// que quien pregunta esté logueado (mismo login de la app) y le pasa todo a Claude.
// La clave de Anthropic vive como secreto ANTHROPIC_API_KEY (nunca en el navegador).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("ASISTENTE_MODEL") || "claude-sonnet-5-5";
const EMAILS_PERMITIDOS = ["carlos.sonnenschein.antelo@gmail.com"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const INSTRUCCIONES = `Sos el asistente de la app de gestión de la estancia ganadera "Los Cepes" (Bolivia), de Carlos Sonnenschein.
Respondés preguntas sobre los datos cargados en la app: gastos e ingresos del Diario, ganado (inventario, compras, ventas, kg, precios), personal (sueldos, adelantos, pulpería, saldos de cada trabajador), almacén, gastos fijos y variables y estados financieros.

Reglas:
- Hablá en español boliviano, claro y directo. Respuestas cortas: primero el dato que se pidió, después un detalle breve si suma.
- Montos en bolivianos con formato "Bs 1.234,50". Pesos en kg.
- Basate SOLO en los datos de abajo. Si algo no está cargado, decilo ("no hay registros de…"); no inventes cifras.
- Para saldos de trabajadores, estados financieros, inventario y totales generales usá primero los RESUMENES CALCULADOS (salen de las mismas fórmulas de la app). Para lo demás, sumá desde las tablas y, si sumaste varias filas, mostrá en una línea qué sumaste para que se pueda verificar.
- Saldo de trabajador: positivo = "saldo a favor" del trabajador (la estancia le debe); negativo = "saldo en contra" (el trabajador debe).
- Los campos que terminan en "Id" apuntan al "id" de otra tabla (ej. empleadoId → EMPLEADOS). Mostrá siempre nombres, nunca ids.
- No podés modificar datos: si Carlos pide cargar o cambiar algo, explicale en qué pantalla de la app hacerlo.
- Usá listas o tablas cortas en markdown solo cuando ayuden a leer.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  // 1) ¿Quién pregunta? (token del login de la app)
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "sin_sesion" }, 401);
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY } });
  if (!u.ok) return json({ error: "sin_sesion" }, 401);
  const user = await u.json();
  if (!EMAILS_PERMITIDOS.includes(String(user.email || "").toLowerCase())) return json({ error: "Usuario no autorizado" }, 403);

  if (!ANTHROPIC_API_KEY) return json({ error: "Falta configurar la clave ANTHROPIC_API_KEY en Supabase." }, 500);

  // 2) Datos de la conversación
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const contexto = String(body.contexto || "").slice(0, 600_000);
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Falta la pregunta" }, 400);

  // 3) Claude (los datos van en un bloque cacheado: las preguntas seguidas salen mucho más baratas)
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: [
        { type: "text", text: INSTRUCCIONES },
        { type: "text", text: "DATOS ACTUALES DE LA APP:\n\n" + contexto, cache_control: { type: "ephemeral" } },
      ],
      messages: msgs,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("anthropic", r.status, JSON.stringify(j));
    return json({ error: "El asistente no pudo responder (" + r.status + "): " + (j?.error?.message || "") }, 502);
  }
  const texto = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  return json({ texto: texto || "(sin respuesta)", uso: j.usage });
});
