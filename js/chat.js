/* ==========================================================================
   chat.js — Asistente IA dentro de la app (botón 💬 abajo a la derecha).
   ==========================================================================
   - Le preguntás en lenguaje normal sobre los datos ("¿cuánto gasté en
     combustible en octubre?", "¿qué saldo tiene el Gordo?") y responde Claude.
   - Cada pregunta manda: la conversación + un resumen de los datos que tiene
     ESTE dispositivo (sin fotos). Los saldos de trabajadores y los estados
     financieros van ya calculados con las mismas fórmulas de la app.
   - La clave de la IA no está acá: la tiene la función "asistente-los-cepes"
     en Supabase, que además verifica que estés logueado.
   - La conversación vive solo mientras la pestaña esté abierta (botón 🗑 la borra).
   ========================================================================== */
(function () {
  "use strict";

  var FN_URL = "https://xmcuvdvyqhatvzyndfnt.supabase.co/functions/v1/asistente-los-cepes";
  var K_HIST = "losCepesChat_hist";
  var historial = [];
  try { historial = JSON.parse(sessionStorage.getItem(K_HIST) || "[]"); } catch (e) { historial = []; }
  var enviando = false;

  /* ---------------- contexto de datos ---------------- */
  var CAMPOS_FOTO = { comprobante: 1, facturaCompra: 1 };

  function celda(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(Math.round(v * 100) / 100);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v).replace(/[\t\r\n]+/g, " ");
  }
  // Array de objetos → tabla con tabulaciones (mucho más corta que JSON)
  function tabla(nombre, filas) {
    if (!Array.isArray(filas) || !filas.length) return "";
    var cols = [];
    filas.forEach(function (f) {
      Object.keys(f || {}).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
    });
    var out = ["## " + nombre.toUpperCase() + " (" + filas.length + " filas)", cols.join("\t")];
    filas.forEach(function (f) {
      out.push(cols.map(function (k) {
        if (CAMPOS_FOTO[k]) return f[k] ? "sí" : "";
        return celda(f[k]);
      }).join("\t"));
    });
    return out.join("\n");
  }
  function redondear(obj) {
    return JSON.stringify(obj, function (k, v) { return typeof v === "number" ? Math.round(v * 100) / 100 : v; });
  }
  function intentar(nombre, fn) {
    try { return "### " + nombre + "\n" + redondear(fn()); } catch (e) { return ""; }
  }
  function hoy() { return new Date().toISOString().slice(0, 10); }

  function saldosTrabajadores() {
    return (STATE.empleados || []).map(function (w) {
      var movs = (STATE.personalMovimientos || []).filter(function (m) { return m.empleadoId === w.id; });
      var sueldoMes = (Number(w.cantidad) || 0) * ((Number(w.haberBasico) || 0) + (Number(w.bonoProd) || 0));
      var adel = sum(movs.map(function (m) { return m.adelanto; }));
      var uten = sum(movs.map(function (m) { return m.utensilios; }));
      var cons = sum(movs.map(function (m) { return m.consumo; }));
      var haber = haberAcumuladoDesdeIngreso(sueldoMes, w.fechaIngreso, hoy(), w);
      var neto = haber != null ? haber - (adel + uten + cons) : null;
      return {
        id: w.id, cargo: w.cargo, nombre: w.nombre, fechaIngreso: w.fechaIngreso || "(sin fecha de ingreso)",
        sueldoMensual: sueldoMes, haberAcumuladoHastaHoy: haber,
        totalAdelantos: adel, totalUtensilios: uten, totalConsumoPulperia: cons,
        saldo: neto == null ? "no calculable (falta fecha de ingreso)" : (neto < 0 ? "Saldo en contra " : "Saldo a favor ") + Math.abs(Math.round(neto * 100) / 100)
      };
    });
  }

  function armarContexto() {
    var anio = STATE.meta && STATE.meta.anio;
    var partes = [
      "Fecha de hoy: " + hoy() + " — Año elegido en la app: " + anio + " — Estancia: " + ((STATE.meta && STATE.meta.nombreEstancia) || "Los Cepes"),
      "",
      "# RESUMENES CALCULADOS (fórmulas de la app)",
      intentar("Saldo de cada trabajador desde su ingreso hasta hoy", saldosTrabajadores),
      intentar("Tablero (año " + anio + ")", function () { var d = calcDashboard(STATE); delete d.alertas; return d; }),
      intentar("Estado de resultados (año " + anio + ")", function () { return calcEstadoResultado(STATE, anio); }),
      intentar("Flujo de caja (año " + anio + ")", function () { return calcFlujoCaja(STATE, anio); }),
      intentar("Balance (año " + anio + ")", function () { return calcBalance(STATE, anio); }),
      intentar("Inventario de ganado por categoría", function () { return calcGanadoInventario(STATE); }),
      intentar("Sueldos (costo mensual/anual)", function () { var s = calcSueldos(STATE); return { totalMensual: s.totalMensual, totalCostoMes: s.totalCostoMes, totalCostoAnual: s.totalCostoAnual }; }),
      "",
      "# TABLAS DE DATOS",
      "### Configuración general\n" + redondear(STATE.meta || {})
    ];
    Object.keys(STATE).forEach(function (k) {
      if (Array.isArray(STATE[k])) { var t = tabla(k, STATE[k]); if (t) partes.push(t); }
    });
    ["inventarioCrea", "pasivosIniciales", "subcategoriasDiario"].forEach(function (k) {
      if (STATE[k] && typeof STATE[k] === "object") partes.push("## " + k.toUpperCase() + "\n" + redondear(STATE[k]));
    });
    return partes.filter(Boolean).join("\n\n");
  }

  /* ---------------- interfaz ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  // markdown mínimo: **negrita**, listas, tablas simples, saltos de línea
  function md(texto) {
    var lineas = esc(texto).split("\n"), html = [], enLista = false, tablaFilas = [];
    function cerrarTabla() {
      if (!tablaFilas.length) return;
      var filas = tablaFilas.filter(function (l) { return !/^\|?\s*:?-{2,}/.test(l); });
      html.push('<div class="chat-tabla"><table>' + filas.map(function (l, i) {
        var c = l.replace(/^\||\|$/g, "").split("|").map(function (x) { return x.trim(); });
        var t = i === 0 ? "th" : "td";
        return "<tr>" + c.map(function (x) { return "<" + t + ">" + x + "</" + t + ">"; }).join("") + "</tr>";
      }).join("") + "</table></div>");
      tablaFilas = [];
    }
    lineas.forEach(function (l) {
      if (/^\s*\|.*\|\s*$/.test(l)) { if (enLista) { html.push("</ul>"); enLista = false; } tablaFilas.push(l.trim()); return; }
      cerrarTabla();
      var m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) { if (!enLista) { html.push("<ul>"); enLista = true; } html.push("<li>" + m[1] + "</li>"); return; }
      if (enLista) { html.push("</ul>"); enLista = false; }
      var h = l.match(/^#{1,4}\s+(.*)$/);
      if (h) { html.push("<p><b>" + h[1] + "</b></p>"); return; }
      html.push(l.trim() ? "<p>" + l + "</p>" : "");
    });
    cerrarTabla();
    if (enLista) html.push("</ul>");
    return html.join("").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }

  var css = "" +
    "#chatFab{position:fixed;right:18px;bottom:18px;z-index:9000;width:56px;height:56px;border-radius:50%;border:0;" +
    "background:var(--green-700,#1f5c3f);color:#fff;font-size:26px;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}" +
    "#chatPanel{position:fixed;right:18px;bottom:86px;z-index:9999;width:380px;max-width:calc(100vw - 24px);height:560px;" +
    "max-height:calc(100vh - 110px);background:var(--panel,#fff);border:1px solid var(--border,#e1e7e3);border-radius:14px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;font:14px system-ui,sans-serif;color:var(--ink,#1f2a24)}" +
    "#chatPanel.abierto{display:flex}" +
    "#chatPanel header{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--green-900,#173d2c);color:#fff}" +
    "#chatPanel header b{flex:1;font-size:15px}" +
    "#chatPanel header button{background:transparent;border:0;color:#fff;font-size:17px;cursor:pointer;padding:2px 6px}" +
    "#chatMsgs{flex:1;overflow-y:auto;padding:12px;background:var(--bg,#f4f6f5)}" +
    ".chat-m{max-width:88%;margin:0 0 10px;padding:9px 12px;border-radius:12px;line-height:1.4;word-wrap:break-word}" +
    ".chat-m p{margin:0 0 6px}.chat-m p:last-child{margin:0}.chat-m ul{margin:4px 0 6px;padding-left:18px}" +
    ".chat-u{margin-left:auto;background:var(--green-700,#1f5c3f);color:#fff;border-bottom-right-radius:4px}" +
    ".chat-a{background:#fff;border:1px solid var(--border,#e1e7e3);border-bottom-left-radius:4px}" +
    ".chat-err{background:var(--red-bg,#fbe6e4);color:var(--red,#b5332a)}" +
    ".chat-tabla{overflow-x:auto;margin:4px 0}.chat-tabla table{border-collapse:collapse;font-size:12.5px}" +
    ".chat-tabla td,.chat-tabla th{border:1px solid var(--border,#e1e7e3);padding:3px 6px;text-align:left;white-space:nowrap}" +
    ".chat-tabla th{background:var(--green-100,#e4f3ea)}" +
    ".chat-sug{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}" +
    ".chat-sug button{border:1px solid var(--green-600,#2c7a4f);background:#fff;color:var(--green-700,#1f5c3f);border-radius:999px;padding:5px 10px;font-size:12.5px;cursor:pointer}" +
    "#chatForm{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border,#e1e7e3);background:#fff}" +
    "#chatInput{flex:1;resize:none;border:1px solid var(--border,#ccc);border-radius:10px;padding:9px 10px;font:15px system-ui,sans-serif;max-height:110px}" +
    "#chatForm button{border:0;border-radius:10px;background:var(--green-700,#1f5c3f);color:#fff;font-weight:700;padding:0 14px;cursor:pointer}" +
    "#chatForm button:disabled{opacity:.5}" +
    ".chat-pensando span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#999;animation:chatp 1s infinite}" +
    ".chat-pensando span:nth-child(2){animation-delay:.15s}.chat-pensando span:nth-child(3){animation-delay:.3s}" +
    "@keyframes chatp{0%,80%,100%{opacity:.25}40%{opacity:1}}" +
    "@media(max-width:560px){#chatPanel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0}" +
    "#chatFab{right:14px;bottom:14px}#chatPanel.abierto~#chatFab{display:none}body.chat-abierto #cloudBadge,body.chat-abierto #losCepesSyncIndicator{display:none!important}}" +
    "@media print{#chatFab,#chatPanel{display:none!important}}";

  var SUGERENCIAS = [
    "¿Cuánto gasté este mes y en qué?",
    "¿Qué saldo tiene cada trabajador?",
    "¿Cuántas cabezas tengo por categoría?",
    "¿Cómo viene el resultado del año?"
  ];

  var panel, msgsEl, input, btn;

  function pintar() {
    if (!historial.length) {
      msgsEl.innerHTML = '<div class="chat-m chat-a"><p>Hola 👋 Preguntame lo que quieras sobre los datos de la estancia: gastos, ganado, trabajadores, almacén o resultados.</p>' +
        '<div class="chat-sug">' + SUGERENCIAS.map(function (s) { return "<button type=\"button\">" + esc(s) + "</button>"; }).join("") + "</div></div>";
      msgsEl.querySelectorAll(".chat-sug button").forEach(function (b) {
        b.addEventListener("click", function () { input.value = b.textContent; enviar(); });
      });
      return;
    }
    msgsEl.innerHTML = historial.map(function (m) {
      if (m.role === "user") return '<div class="chat-m chat-u">' + esc(m.content).replace(/\n/g, "<br>") + "</div>";
      return '<div class="chat-m chat-a' + (m.error ? " chat-err" : "") + '">' + md(m.content) + "</div>";
    }).join("") + (enviando ? '<div class="chat-m chat-a chat-pensando"><span></span><span></span><span></span></div>' : "");
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function guardar() { try { sessionStorage.setItem(K_HIST, JSON.stringify(historial.slice(-40))); } catch (e) {} }

  async function enviar() {
    var q = input.value.trim();
    if (!q || enviando) return;
    input.value = ""; input.style.height = "";
    historial.push({ role: "user", content: q });
    enviando = true; btn.disabled = true; pintar();
    try {
      var tok = typeof window.losCepesToken === "function" ? await window.losCepesToken() : null;
      if (!tok) throw new Error("Tenés que entrar con tu correo y contraseña para usar el asistente.");
      var r = await fetch(FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },
        body: JSON.stringify({
          contexto: armarContexto(),
          messages: historial.filter(function (m) { return !m.error; }).map(function (m) { return { role: m.role, content: m.content }; })
        })
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error === "sin_sesion" ? "Tu sesión venció: recargá la página y volvé a entrar." : (j.error || ("Error " + r.status)));
      historial.push({ role: "assistant", content: j.texto });
    } catch (e) {
      var msg = navigator.onLine ? e.message : "Sin conexión a internet — el asistente necesita señal.";
      historial.push({ role: "assistant", content: "⚠️ " + msg, error: true });
    } finally {
      enviando = false; btn.disabled = false; guardar(); pintar(); input.focus();
    }
  }

  function montar() {
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    panel = document.createElement("div");
    panel.id = "chatPanel";
    panel.innerHTML =
      '<header><span>🤖</span><b>Asistente Los Cepes</b>' +
      '<button type="button" id="chatClear" title="Borrar conversación">🗑</button>' +
      '<button type="button" id="chatClose" title="Cerrar">✕</button></header>' +
      '<div id="chatMsgs"></div>' +
      '<form id="chatForm"><textarea id="chatInput" rows="1" placeholder="Escribí tu pregunta…"></textarea>' +
      '<button type="submit">Enviar</button></form>';
    var fab = document.createElement("button");
    fab.id = "chatFab"; fab.type = "button"; fab.title = "Asistente"; fab.textContent = "💬";
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    msgsEl = panel.querySelector("#chatMsgs");
    input = panel.querySelector("#chatInput");
    btn = panel.querySelector("#chatForm button");

    fab.addEventListener("click", function () {
      panel.classList.toggle("abierto");
      document.body.classList.toggle("chat-abierto", panel.classList.contains("abierto"));
      if (panel.classList.contains("abierto")) { pintar(); input.focus(); }
    });
    panel.querySelector("#chatClose").addEventListener("click", function () { panel.classList.remove("abierto"); document.body.classList.remove("chat-abierto"); });
    panel.querySelector("#chatClear").addEventListener("click", function () {
      if (enviando) return;
      historial = []; guardar(); pintar();
    });
    panel.querySelector("#chatForm").addEventListener("submit", function (e) { e.preventDefault(); enviar(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !/Mobi|Android|iPhone/i.test(navigator.userAgent)) { e.preventDefault(); enviar(); }
    });
    input.addEventListener("input", function () { input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montar);
  else montar();
})();
