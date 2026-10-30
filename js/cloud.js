/* ==========================================================================
   cloud.js — guarda los datos de la app en Supabase para que la computadora
   y el celular vean siempre lo mismo.
   ==========================================================================
   - Se entra con el mismo correo y contraseña de Supabase (los de Nogalmax).
     Las tablas solo dejan leer/escribir a ese correo (políticas RLS).
   - Los datos siguen guardándose también en el navegador (localStorage), así
     la app abre al instante y funciona sin señal; cuando vuelve la conexión
     sube lo pendiente.
   - Cada guardado local se sube a la nube a los ~2 s. Cada 20 s revisa si
     otro dispositivo guardó algo más nuevo y lo trae.
   - Las fotos de comprobantes van en una tabla aparte (se suben una sola vez).
   ========================================================================== */
(function () {
  "use strict";

  var URL_SB = "https://xmcuvdvyqhatvzyndfnt.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY3V2ZHZ5cWhhdHZ6eW5kZm50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NjI2NzMsImV4cCI6MjEwMzIzODY3M30.93zGxehNupxc1AbfkgjH_ChK2QwvcTzjn-mJF__EeMQ";
  var K_SESSION = "losCepesCloud_session";
  var K_VERSION = "losCepesCloud_version";   // última versión de la nube que tiene este dispositivo
  var K_DIRTY   = "losCepesCloud_dirty";     // "1" = hay cambios locales sin subir
  var K_IMGS_UP = "losCepesCloud_imgsSubidas";
  var PULL_MS = 20000;

  var ready = false, pushing = false, pushTimer = null, applyingRemote = false;

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function session() { try { return JSON.parse(ls(K_SESSION) || "null"); } catch (e) { return null; } }
  function deviceName() { return /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "celular" : "computadora"; }

  /* ---------- indicador ---------- */
  function badge(text, color) {
    var el = document.getElementById("cloudBadge");
    if (!el) {
      el = document.createElement("div");
      el.id = "cloudBadge";
      el.style.cssText = "position:fixed;top:8px;right:10px;z-index:9998;font:600 11px system-ui,sans-serif;" +
        "padding:4px 10px;border-radius:999px;background:#1b1d17;color:#fff;opacity:.9;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.color = color || "#8ed4b4";
  }

  /* ---------- autenticación ---------- */
  async function authFetch(path, body) {
    var r = await fetch(URL_SB + "/auth/v1/" + path, {
      method: "POST",
      headers: { "apikey": ANON, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || ("error " + r.status));
    return j;
  }
  function guardarSesion(j) {
    ls(K_SESSION, JSON.stringify({
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: j.user && j.user.email
    }));
  }
  async function token() {
    var s = session();
    if (!s) return null;
    if (Date.now() > s.expires_at - 60000) {
      try { guardarSesion(await authFetch("token?grant_type=refresh_token", { refresh_token: s.refresh_token })); }
      catch (e) { if (navigator.onLine) { ls(K_SESSION, null); } return null; }
      s = session();
    }
    return s.access_token;
  }

  async function api(method, path, body, extraHeaders) {
    var t = await token();
    if (!t) throw new Error("sin_sesion");
    var h = { "apikey": ANON, "Authorization": "Bearer " + t, "Content-Type": "application/json" };
    if (extraHeaders) for (var k in extraHeaders) h[k] = extraHeaders[k];
    var r = await fetch(URL_SB + "/rest/v1/" + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { ls(K_SESSION, null); throw new Error("sin_sesion"); }
    if (!r.ok) throw new Error("http " + r.status + " " + (await r.text()).slice(0, 200));
    var txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  function pantallaLogin(msg) {
    var ov = document.getElementById("cloudLogin");
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.id = "cloudLogin";
    ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(20,22,18,.82);display:flex;align-items:center;justify-content:center;padding:16px";
    ov.innerHTML =
      '<form style="background:#fff;color:#1b1d17;border-radius:14px;padding:22px;max-width:360px;width:100%;font:14px system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35)">' +
      '<div style="font-weight:700;font-size:17px;margin-bottom:4px">Estancia Los Cepes</div>' +
      '<div style="color:#555;margin-bottom:14px">Entrá con tu correo y contraseña (los mismos de Nogalmax) para ver tus datos en la compu y en el celular.</div>' +
      '<input id="clEmail" type="email" placeholder="Correo" autocomplete="username" required style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:8px;border:1px solid #ccc;border-radius:8px;font-size:15px">' +
      '<input id="clPass" type="password" placeholder="Contraseña" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:10px;border:1px solid #ccc;border-radius:8px;font-size:15px">' +
      '<div id="clMsg" style="color:#b3261e;min-height:18px;margin-bottom:8px">' + (msg || "") + '</div>' +
      '<button type="submit" style="width:100%;padding:11px;border:0;border-radius:8px;background:#2f5d3a;color:#fff;font-weight:700;font-size:15px">Ingresar</button>' +
      '</form>';
    document.body.appendChild(ov);
    var s = session();
    ov.querySelector("#clEmail").value = (s && s.email) || "carlos.sonnenschein.antelo@gmail.com";
    ov.querySelector("form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var m = ov.querySelector("#clMsg");
      m.style.color = "#555"; m.textContent = "Ingresando…";
      try {
        guardarSesion(await authFetch("token?grant_type=password", {
          email: ov.querySelector("#clEmail").value.trim(), password: ov.querySelector("#clPass").value
        }));
        ov.remove();
        arrancar();
      } catch (err) {
        m.style.color = "#b3261e";
        m.textContent = /invalid/i.test(err.message) ? "Correo o contraseña incorrectos." : ("No se pudo ingresar: " + err.message);
      }
    });
  }

  /* ---------- helpers de datos ---------- */
  function hayDatos(st) {
    if (!st) return false;
    return ["diario", "ganadoMovimiento", "personalMovimientos", "animales", "almacenMovimientos"]
      .some(function (k) { return (st[k] || []).length > 0; });
  }
  function estadoLocalCrudo() {
    try { return JSON.parse(ls(STORAGE_KEY) || "null"); } catch (e) { return null; }
  }

  async function aplicarRemoto(row) {
    applyingRemote = true;
    try {
      // traer fotos que falten en este dispositivo
      var imgs = loadImages();
      var lista = await api("GET", "los_cepes_imgs?select=id");
      var faltan = (lista || []).map(function (r) { return r.id; }).filter(function (id) { return !imgs[id]; });
      for (var i = 0; i < faltan.length; i += 20) {
        var lote = faltan.slice(i, i + 20).map(function (id) { return '"' + id.replace(/"/g, "") + '"'; }).join(",");
        var got = await api("GET", "los_cepes_imgs?select=id,data&id=in.(" + encodeURIComponent(lote) + ")");
        (got || []).forEach(function (g) { imgs[g.id] = g.data; });
      }
      saveImages(imgs);
      ls(K_IMGS_UP, JSON.stringify(Object.keys(imgs)));
      ls(STORAGE_KEY, JSON.stringify(row.state));
      ls(K_VERSION, String(row.version));
      ls(K_DIRTY, null);
      loadState();
      if (typeof actualizarMarcaEnPantalla === "function") try { actualizarMarcaEnPantalla(); } catch (e) {}
      if (typeof refreshCurrentView === "function") try { refreshCurrentView(); } catch (e) {}
    } finally {
      applyingRemote = false;
    }
  }

  async function subirFotos() {
    var imgs = loadImages();
    var subidas;
    try { subidas = new Set(JSON.parse(ls(K_IMGS_UP) || "[]")); } catch (e) { subidas = new Set(); }
    var nuevas = Object.keys(imgs).filter(function (id) { return !subidas.has(id); });
    for (var i = 0; i < nuevas.length; i += 5) {
      var lote = nuevas.slice(i, i + 5).map(function (id) { return { id: id, data: imgs[id] }; });
      await api("POST", "los_cepes_imgs?on_conflict=id", lote, { "Prefer": "resolution=merge-duplicates,return=minimal" });
      lote.forEach(function (x) { subidas.add(x.id); });
      ls(K_IMGS_UP, JSON.stringify(Array.from(subidas)));
    }
  }

  async function subir() {
    if (!ready || pushing) return;
    if (ls(K_DIRTY) !== "1") return;
    pushing = true;
    badge("☁️ Subiendo…", "#f2c94c");
    try {
      await subirFotos();
      var st = estadoLocalCrudo();
      if (!st) return;
      var v = Number(ls(K_VERSION) || 0);
      var res;
      if (v === 0) {
        res = await api("POST", "los_cepes_estado", { id: "main", state: st, version: 1, updated_by: deviceName() },
          { "Prefer": "return=representation" });
      } else {
        res = await api("PATCH", "los_cepes_estado?id=eq.main&version=eq." + v,
          { state: st, version: v + 1, updated_at: new Date().toISOString(), updated_by: deviceName() },
          { "Prefer": "return=representation" });
      }
      if (res && res.length) {
        ls(K_VERSION, String(res[0].version));
        ls(K_DIRTY, null);
        badge("☁️ Guardado en la nube");
      } else {
        // otro dispositivo guardó antes: resolver
        await resolverConflicto();
      }
    } catch (e) {
      if (String(e.message) === "sin_sesion") pantallaLogin("Tu sesión venció, volvé a entrar.");
      else badge("☁️ Sin conexión — se sube cuando vuelva", "#f2994a");
    } finally {
      pushing = false;
    }
  }

  async function resolverConflicto() {
    var rows = await api("GET", "los_cepes_estado?id=eq.main&select=*");
    var row = rows && rows[0];
    if (!row) { ls(K_VERSION, "0"); return subir(); }
    var usarEste = confirm(
      "Se guardaron cambios desde otro dispositivo (" + (row.updated_by || "otro") + ") mientras cargabas acá.\n\n" +
      "Aceptar = quedarse con lo de ESTE dispositivo (lo del otro se pierde)\n" +
      "Cancelar = traer lo del otro dispositivo (lo último de acá se pierde)"
    );
    if (usarEste) { ls(K_VERSION, String(row.version)); pushing = false; return subir(); }
    await aplicarRemoto(row);
    badge("☁️ Actualizado desde " + (row.updated_by || "la nube"));
  }

  async function traer() {
    if (!ready || pushing || applyingRemote) return;
    try {
      var rows = await api("GET", "los_cepes_estado?id=eq.main&select=version,updated_by");
      var row = rows && rows[0];
      if (!row) return;
      var v = Number(ls(K_VERSION) || 0);
      if (row.version > v) {
        if (ls(K_DIRTY) === "1") return resolverConflicto();
        var full = await api("GET", "los_cepes_estado?id=eq.main&select=*");
        await aplicarRemoto(full[0]);
        badge("☁️ Actualizado desde " + (row.updated_by || "la nube"));
      } else if (ls(K_DIRTY) === "1") {
        subir();
      } else {
        badge("☁️ Al día");
      }
    } catch (e) {
      if (String(e.message) === "sin_sesion") pantallaLogin("Tu sesión venció, volvé a entrar.");
      else badge("☁️ Sin conexión", "#f2994a");
    }
  }

  /* ---------- primer arranque en este dispositivo ---------- */
  async function arrancar() {
    if (!session()) { pantallaLogin(); return; }
    badge("☁️ Conectando…", "#f2c94c");
    try {
      var rows = await api("GET", "los_cepes_estado?id=eq.main&select=*");
      var row = rows && rows[0];
      var v = Number(ls(K_VERSION) || 0);
      var local = estadoLocalCrudo();
      ready = true;
      if (!row) {
        // la nube está vacía: este dispositivo sube lo que tiene
        ls(K_VERSION, "0");
        if (local) { ls(K_DIRTY, "1"); await subir(); }
        else badge("☁️ Conectado");
      } else if (v === 0) {
        // primera vez en este dispositivo y la nube ya tiene datos
        if (hayDatos(local) && !confirm(
          "La nube ya tiene datos (guardados desde " + (row.updated_by || "otro dispositivo") + ").\n\n" +
          "Aceptar = usar los datos de la nube en este dispositivo (recomendado)\n" +
          "Cancelar = reemplazar la nube con lo que hay en este dispositivo")) {
          ls(K_VERSION, String(row.version)); ls(K_DIRTY, "1"); await subir();
        } else {
          await aplicarRemoto(row);
          badge("☁️ Datos traídos de la nube");
        }
      } else {
        await traer();
      }
      setInterval(traer, PULL_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) traer(); });
      window.addEventListener("online", function () { traer(); });
    } catch (e) {
      if (String(e.message) === "sin_sesion") pantallaLogin("Tu sesión venció, volvé a entrar.");
      else { badge("☁️ Sin conexión", "#f2994a"); setTimeout(arrancar, 15000); }
    }
  }

  /* ---------- engancharse a saveState ---------- */
  var saveOriginal = window.saveState;
  window.saveState = function () {
    var r = saveOriginal.apply(this, arguments);
    if (!applyingRemote) {
      ls(K_DIRTY, "1");
      clearTimeout(pushTimer);
      pushTimer = setTimeout(subir, 2000); // saveState escribe en localStorage a los 150 ms
    }
    return r;
  };

  window.losCepesCerrarSesion = function () { ls(K_SESSION, null); location.reload(); };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(arrancar, 300); });
  else setTimeout(arrancar, 300);
})();
