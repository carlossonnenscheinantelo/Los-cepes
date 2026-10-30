/* ==========================================================================
   sync.js — sincronización con Caja Clara (app personal de gastos de Carlos)
   ==========================================================================
   Archivo NUEVO y aditivo: no modifica db.js, calc.js, charts.js ni render.js.
   Cada tanto revisa una tabla en Supabase donde Caja Clara deja los pagos/cobros
   que Carlos cargó para la Cuenta 3 · Los Cepes, y los agrega al Diario local
   usando las funciones que ya existen (crudAdd), para que se calculen y
   aparezcan exactamente igual que si se hubieran cargado acá directamente.

   Acceso sin login (clave anon + política abierta SOLO en esta tabla) — así lo
   pidió Carlos, porque ni esta app ni Caja Clara tienen pantalla de inicio de
   sesión, y él quiere poder seguir subiendo gastos directo desde el celular
   (incluida una futura carga por WhatsApp) sin tener que iniciar sesión.
   ========================================================================== */
(function () {
  "use strict";

  var SUPABASE_URL = "https://xmcuvdvyqhatvzyndfnt.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY3V2ZHZ5cWhhdHZ6eW5kZm50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NjI2NzMsImV4cCI6MjEwMzIzODY3M30.93zGxehNupxc1AbfkgjH_ChK2QwvcTzjn-mJF__EeMQ";
  var TABLE = "los_cepes_diario_sync";
  var POLL_MS = 25000;
  var syncing = false;

  function headers(extra) {
    var h = { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function ensureIndicator() {
    var el = document.getElementById("losCepesSyncIndicator");
    if (!el) {
      el = document.createElement("div");
      el.id = "losCepesSyncIndicator";
      el.style.cssText = "position:fixed;bottom:10px;right:10px;background:#1b1d17;color:#8ed4b4;" +
        "font:11px system-ui,sans-serif;padding:5px 10px;border-radius:999px;z-index:9999;" +
        "opacity:0.88;box-shadow:0 4px 14px rgba(0,0,0,0.25);pointer-events:none;transition:opacity .3s;";
      document.body.appendChild(el);
    }
    return el;
  }

  function showIndicator(text, autoHide) {
    var el = ensureIndicator();
    el.textContent = text;
    el.style.opacity = "0.88";
    if (autoHide) {
      clearTimeout(showIndicator._t);
      showIndicator._t = setTimeout(function () { el.style.opacity = "0"; }, 4000);
    }
  }

  function mapRowToDiario(r) {
    return {
      fecha: r.fecha,
      tipo: r.tipo === "INGRESO" ? "INGRESO" : "EGRESO",
      categoria: r.categoria || "Otros Egresos",
      subcategoria: r.subcategoria || "",
      monto: Number(r.monto) || 0,
      cuenta: r.cuenta || "Caja / Efectivo",
      beneficiario: r.beneficiario || "",
      observaciones: (r.observaciones ? r.observaciones + " " : "") + "(cargado desde Caja Clara)"
    };
  }

  async function poll() {
    if (syncing) return;
    if (typeof STATE === "undefined" || typeof crudAdd !== "function") return; // la app todavía no cargó
    syncing = true;
    try {
      var res = await fetch(
        SUPABASE_URL + "/rest/v1/" + TABLE + "?imported=eq.false&order=created_at.asc&select=*",
        { headers: headers() }
      );
      if (!res.ok) throw new Error("http " + res.status);
      var rows = await res.json();
      if (rows && rows.length) {
        var importedIds = [];
        for (var i = 0; i < rows.length; i++) {
          try {
            crudAdd("diario", mapRowToDiario(rows[i]));
            importedIds.push(rows[i].id);
          } catch (e) {
            // si una fila puntual falla, seguimos con las demás; queda para el próximo intento
          }
        }
        if (importedIds.length) {
          await fetch(
            SUPABASE_URL + "/rest/v1/" + TABLE + "?id=in.(" + importedIds.join(",") + ")",
            {
              method: "PATCH",
              headers: headers({ "Content-Type": "application/json", "Prefer": "return=minimal" }),
              body: JSON.stringify({ imported: true, imported_at: new Date().toISOString() })
            }
          );
          if (typeof refreshCurrentView === "function") { try { refreshCurrentView(); } catch (e) {} }
          showIndicator(
            "Caja Clara: " + importedIds.length + " movimiento" + (importedIds.length === 1 ? "" : "s") + " cargado" + (importedIds.length === 1 ? "" : "s"),
            true
          );
        } else {
          showIndicator("Caja Clara: al día", true);
        }
      } else {
        showIndicator("Caja Clara: al día", true);
      }
    } catch (e) {
      showIndicator("Caja Clara: sin conexión", true);
    } finally {
      syncing = false;
    }
  }

  function start() {
    poll();
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(start, 800); // deja que main.js/init() termine de cargar STATE primero
  } else {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 800); });
  }
})();
