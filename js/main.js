/* ==========================================================================
   main.js — arranque de la app: router por hash, sidebar móvil, selector de año
   ========================================================================== */

function currentViewFromHash() {
  const h = location.hash.replace(/^#\/?/, "");
  return h || "inicio";
}

function populateYearSelect() {
  const sel = document.getElementById("yearSelect");
  const anioActual = STATE.meta.anio;
  const years = new Set([anioActual]);
  STATE.diario.forEach(r => { const y = (r.fecha||"").slice(0,4); if (y) years.add(Number(y)); });
  STATE.ganadoMovimiento.forEach(r => { const y = (r.fecha||"").slice(0,4); if (y) years.add(Number(y)); });
  const base = new Date().getFullYear();
  for (let y = base - 2; y <= base + 1; y++) years.add(y);
  const sorted = Array.from(years).sort((a,b) => a-b);
  sel.innerHTML = sorted.map(y => `<option value="${y}" ${y===anioActual?"selected":""}>${y}</option>`).join("");
  sel.addEventListener("change", () => {
    STATE.meta.anio = Number(sel.value);
    saveState();
    refreshCurrentView();
  });
}

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const open = () => { sidebar.classList.add("open"); overlay.classList.add("show"); };
  const close = () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); };
  document.getElementById("openSidebar").addEventListener("click", open);
  document.getElementById("closeSidebar").addEventListener("click", close);
  overlay.addEventListener("click", close);
  document.querySelectorAll("#mainNav a").forEach(a => a.addEventListener("click", close));
}

/** Refleja STATE.meta.nombreEstancia en el título de la pestaña y en el nombre del sidebar. */
function actualizarMarcaEnPantalla() {
  const nombre = STATE.meta.nombreEstancia || "Estancia Los Cepes";
  document.title = `${nombre} — Gestión Ganadera`;
  const brandTitle = document.getElementById("brandTitle");
  if (brandTitle) brandTitle.textContent = nombre;
}

function init() {
  loadState();
  actualizarMarcaEnPantalla();
  populateYearSelect();
  setupSidebar();
  renderView(currentViewFromHash());
  window.addEventListener("hashchange", () => renderView(currentViewFromHash()));
}

document.addEventListener("DOMContentLoaded", init);
