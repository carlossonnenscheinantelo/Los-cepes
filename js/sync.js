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
      observaciones: (r.observaciones ? r.observaciones + " " : "") + origenLabel(r),
      descripcion: r.observaciones || "",
      numeroComprobante: r.numero_comprobante || "",
      comprobante: r.comprobante_img || ""
    };
  }

  function origenLabel(r) {
    return r.origen === "claude" ? "(cargado desde Claude)" : "(cargado desde Caja Clara)";
  }

  function norm(s) { return String(s || "").trim().toLowerCase(); }

  function buscarEmpleado(nombre) {
    var n = norm(nombre);
    if (!n) return null;
    var lista = STATE.empleados || [];
    var hit = lista.find(function (e) { return norm(e.cargo) === n; });
    if (!hit) hit = lista.find(function (e) { return norm(e.cargo).indexOf(n) >= 0 || n.indexOf(norm(e.cargo)) >= 0; });
    return hit || null;
  }

  // Importa una fila de la tabla de sincronización. Si trae trabajador + tipo_personal,
  // se registra igual que el formulario "Adelantos y consumos de trabajadores":
  // movimiento en la ficha del trabajador y, si es adelanto, también el egreso en el Diario.
  // Si no, va directo al Diario (como siempre).
  function importRow(r) {
    var base = mapRowToDiario(r);
    var tp = r.tipo_personal || "";
    var emp = r.trabajador ? buscarEmpleado(r.trabajador) : null;
    if (r.trabajador && !emp) throw new Error("trabajador no encontrado: " + r.trabajador);

    if (emp && tp) {
      var tipoLabel = tp === "adelanto" ? "Adelanto" : tp === "consumo" ? "Víveres / Pedidos" : "Utensilios";
      crudAdd("personalMovimientos", {
        empleadoId: emp.id, fecha: base.fecha,
        concepto: r.observaciones ? tipoLabel + " — " + r.observaciones : tipoLabel,
        adelanto: tp === "adelanto" ? base.monto : 0,
        utensilios: tp === "utensilios" ? base.monto : 0,
        consumo: tp === "consumo" ? base.monto : 0,
        observacion: origenLabel(r),
        numeroComprobante: base.numeroComprobante, beneficiario: base.beneficiario,
        comprobante: base.comprobante, facturaCompra: ""
      });
      if (tp === "adelanto") {
        base.categoria = "Adelanto a Personal";
        base.subcategoria = emp.cargo;
        base.descripcion = "Adelanto a " + emp.cargo + (r.observaciones ? " — " + r.observaciones : "");
        crudAdd("diario", base);
      }
      return;
    }
    if (emp) {
      // pago a un trabajador sin descuento de ficha (ej. sueldo): va al Diario con su nombre
      if (!base.subcategoria) base.subcategoria = emp.cargo;
      if (!base.beneficiario) base.beneficiario = emp.cargo;
    }
    crudAdd("diario", base);
  }

  async function poll() {
    if (syncing) return;
    if (typeof STATE === "undefined" || typeof crudAdd !== "function") return; // la app todavía no cargó
    syncing = true;
    try {
      // "Reclama" las filas pendientes en un solo paso (las marca importadas y las devuelve),
      // así si la app está abierta en la compu y en el celular a la vez, cada fila
      // la toma un solo dispositivo y no se duplica.
      var res = await fetch(
        SUPABASE_URL + "/rest/v1/" + TABLE + "?imported=eq.false&order=created_at.asc",
        {
          method: "PATCH",
          headers: headers({ "Content-Type": "application/json", "Prefer": "return=representation" }),
          body: JSON.stringify({ imported: true, imported_at: new Date().toISOString() })
        }
      );
      if (!res.ok) throw new Error("http " + res.status);
      var rows = await res.json();
      if (rows && rows.length) {
        rows.sort(function (x, y) { return String(x.created_at).localeCompare(String(y.created_at)); });
        var ok = 0, fallidas = [];
        for (var i = 0; i < rows.length; i++) {
          try { importRow(rows[i]); ok++; }
          catch (e) { fallidas.push(rows[i].id); } // ej. trabajador que no existe: se devuelve a pendiente
        }
        if (fallidas.length) {
          await fetch(SUPABASE_URL + "/rest/v1/" + TABLE + "?id=in.(" + fallidas.join(",") + ")", {
            method: "PATCH",
            headers: headers({ "Content-Type": "application/json", "Prefer": "return=minimal" }),
            body: JSON.stringify({ imported: false, imported_at: null })
          });
        }
        if (ok) {
          if (typeof refreshCurrentView === "function") { try { refreshCurrentView(); } catch (e) {} }
          showIndicator("Sincronizado: " + ok + " movimiento" + (ok === 1 ? "" : "s") + " cargado" + (ok === 1 ? "" : "s"), true);
        }
      }
    } catch (e) {
      showIndicator("Sincronización: sin conexión", true);
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
