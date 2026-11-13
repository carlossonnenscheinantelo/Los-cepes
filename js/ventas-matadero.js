/* ==========================================================================
   ventas-matadero.js — sección "Ventas a Matadero"
   ==========================================================================
   Lleva las ventas de vacas/novillos al matadero y lo que el comprador va
   pagando, y arma solo el resumen (total neto, pagado, por cobrar).

   Datos (dentro de STATE, así se guardan y sincronizan con la nube igual que
   el resto de la app):
   - STATE.ventasMatadero: una línea por tipo de animal de cada venta
       { id, venta (Nº), fecha (AAAA-MM-DD), tipo ("V" vaca | "N" novillo),
         res, kg, precio (Bs/kg), flete (Bs, se descuenta), fleteDesc,
         origen, obs }
     Si una venta tiene vacas y novillos se cargan dos líneas con el mismo Nº.
   - STATE.pagosMatadero: { id, fecha, monto, forma, nota }

   Esta sección NO pasa nada al Diario ni a Ganado: es el control de cobro de
   estas ventas. El resumen se puede bajar como imagen (PNG) o Excel.
   ========================================================================== */

const VM_TIPOS = { V: "Vaca", N: "Novillo" };
const VM_FORMAS = ["Efectivo", "Transferencia", "Depósito", "Cheque", "Otro"];

if (!uiState.vmTab) uiState.vmTab = "resumen";

/* ---------------- cálculos ---------------- */
function vmBruto(l) { return (Number(l.kg) || 0) * (Number(l.precio) || 0); }
function vmFlete(l) { return Number(l.flete) || 0; }
function vmNeto(l) { return vmBruto(l) - vmFlete(l); }
function vmDiaMes(iso) { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}` : "s/f"; }
function vmEntero(n) { return Math.round(Number(n) || 0).toLocaleString("es-BO"); }
function vmProm(kg, res) { return res ? (kg / res).toLocaleString("es-BO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "–"; }

function calcVentasMatadero(state) {
  const lineas = state.ventasMatadero || [];
  const grupos = new Map();
  lineas.forEach(l => {
    const n = Number(l.venta) || 0;
    if (!grupos.has(n)) grupos.set(n, []);
    grupos.get(n).push(l);
  });
  const ventas = [...grupos.keys()].sort((a, b) => a - b).map(n => {
    const ls = grupos.get(n).slice().sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    let res = 0, kg = 0, bruto = 0, flete = 0;
    const porTipo = {};
    ls.forEach(l => {
      const r = Number(l.res) || 0;
      res += r; kg += Number(l.kg) || 0; bruto += vmBruto(l); flete += vmFlete(l);
      porTipo[l.tipo] = (porTipo[l.tipo] || 0) + r;
    });
    const fechas = [...new Set(ls.map(l => l.fecha).filter(Boolean))];
    const fecha = !fechas.length ? "s/f"
      : fechas.length > 1 ? `${vmDiaMes(fechas[0]).split("/")[0]}-${vmDiaMes(fechas[fechas.length - 1])}`
      : vmDiaMes(fechas[0]);
    return {
      n, lineas: ls, fecha, res, kg, bruto, flete, neto: bruto - flete,
      resTxt: ["V", "N"].filter(t => porTipo[t]).map(t => `${porTipo[t]} ${t}`).join(" + "),
      origen: [...new Set(ls.map(l => l.origen).filter(Boolean))].join(", "),
      obs: [...new Set(ls.map(l => l.obs).filter(Boolean))].join(" · "),
      fletes: ls.filter(l => vmFlete(l)).map(l => ({ desc: l.fleteDesc ? `Flete ${l.fleteDesc}` : "Flete", monto: vmFlete(l) }))
    };
  });
  const pagos = (state.pagosMatadero || []).slice().sort((a, b) => {
    if (!a.fecha && b.fecha) return 1;
    if (a.fecha && !b.fecha) return -1;
    return (a.fecha || "").localeCompare(b.fecha || "");
  });
  const tot = ventas.reduce((t, v) => ({ res: t.res + v.res, kg: t.kg + v.kg, bruto: t.bruto + v.bruto, flete: t.flete + v.flete, neto: t.neto + v.neto }),
    { res: 0, kg: 0, bruto: 0, flete: 0, neto: 0 });
  const pagado = pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  const porTipo = {};
  lineas.forEach(l => {
    const t = porTipo[l.tipo] || (porTipo[l.tipo] = { res: 0, kg: 0 });
    t.res += Number(l.res) || 0; t.kg += Number(l.kg) || 0;
  });
  return { ventas, pagos, tot, pagado, saldo: tot.neto - pagado, pct: tot.neto > 0 ? pagado / tot.neto : 0, porTipo };
}

/* ---------------- vista ---------------- */
function renderVentasMatadero(root) {
  const M = calcVentasMatadero(STATE);
  const tab = uiState.vmTab;
  const saldoTxt = M.saldo < 0 ? `Pagado de más: ${fmtMoney(-M.saldo)}` : "";
  root.innerHTML = `
    <div class="note">Ventas de vacas a matadero de la estancia (en las planillas del matadero figura como <b>Sonneschein 9</b>).
      Cargá las ventas y los pagos: el resumen, la imagen y el Excel se arman solos.</div>

    <div class="grid cols-3 section">
      <div class="card kpi"><span class="kpi-label">Total neto (con flete descontado)</span><span class="kpi-value">${fmtMoney(M.tot.neto)}</span>
        <span class="kpi-sub">${M.tot.res} res · ${fmtNum(M.tot.kg)} kg · prom. ${vmProm(M.tot.kg, M.tot.res)} kg</span></div>
      <div class="card kpi"><span class="kpi-label">Pagado</span><span class="kpi-value pos">${fmtMoney(M.pagado)}</span>
        <span class="kpi-sub">${M.pagos.length} pago${M.pagos.length === 1 ? "" : "s"} · ${fmtPct(M.pct)} cobrado</span></div>
      <div class="card kpi"><span class="kpi-label">Por cobrar</span><span class="kpi-value ${M.saldo > 0 ? "neg" : "pos"}">${fmtMoney(Math.max(M.saldo, 0))}</span>
        <span class="kpi-sub">${saldoTxt || (M.saldo <= 0 && M.tot.neto > 0 ? "Cobrado completo" : "&nbsp;")}</span></div>
    </div>

    <div class="tabs">
      <button class="tab-btn ${tab === "resumen" ? "active" : ""}" data-vmtab="resumen">Resumen</button>
      <button class="tab-btn ${tab === "ventas" ? "active" : ""}" data-vmtab="ventas">Cargar ventas</button>
      <button class="tab-btn ${tab === "pagos" ? "active" : ""}" data-vmtab="pagos">Cargar pagos</button>
    </div>
    <div id="vmBody"></div>`;
  root.querySelectorAll("[data-vmtab]").forEach(b => b.addEventListener("click", () => { uiState.vmTab = b.dataset.vmtab; refreshCurrentView(); }));
  const body = root.querySelector("#vmBody");
  if (tab === "ventas") vmRenderVentas(body, M);
  else if (tab === "pagos") vmRenderPagos(body, M);
  else vmRenderResumen(body, M);
}

function vmRenderResumen(body, M) {
  const filasV = M.ventas.map(v => `
      <tr><td>${v.n}</td><td>${escapeHtml(v.fecha)}</td><td>${escapeHtml(v.resTxt)}</td><td>${escapeHtml(v.origen || "–")}</td>
        <td class="num">${vmProm(v.kg, v.res)}</td><td class="num">${fmtNum(v.kg)}</td><td class="num">${vmEntero(v.bruto)}</td></tr>
      ${v.fletes.map(f => `<tr><td></td><td colspan="5" style="color:var(--red)">${escapeHtml(f.desc)}</td><td class="num" style="color:var(--red)">−${vmEntero(f.monto)}</td></tr>`).join("")}`).join("");
  const filasP = M.pagos.map(p => `
      <tr><td>${vmDiaMes(p.fecha)}</td><td>${escapeHtml(p.forma || "")}</td><td>${escapeHtml(p.nota || "")}</td><td class="num">${vmEntero(p.monto)}</td></tr>`).join("");
  const tipos = Object.entries(M.porTipo).filter(([, t]) => t.res).map(([k, t]) =>
    `<div class="card kpi"><span class="kpi-label">${VM_TIPOS[k] || k}s</span><span class="kpi-value" style="font-size:18px">${t.res} res · ${fmtNum(t.kg)} kg</span><span class="kpi-sub">Promedio ${vmProm(t.kg, t.res)} kg por res</span></div>`).join("");
  body.innerHTML = `
    <div class="datos-actions" style="margin-bottom:14px">
      <button class="btn" id="vmPng">⬇️ Bajar imagen</button>
      <button class="btn secondary" id="vmXls">⬇️ Bajar Excel</button>
    </div>
    <div class="section">
      <h3 class="section-title">Ventas</h3>
      ${M.ventas.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Venta</th><th>Fecha</th><th>Res</th><th>Origen</th><th class="num">Prom kg</th><th class="num">Kg</th><th class="num">Bs</th></tr></thead>
        <tbody>${filasV}</tbody>
        <tfoot><tr><td>Total neto</td><td></td><td>${M.tot.res} res</td><td></td><td class="num">${vmProm(M.tot.kg, M.tot.res)}</td><td class="num">${fmtNum(M.tot.kg)}</td><td class="num">${vmEntero(M.tot.neto)}</td></tr></tfoot>
      </table></div>` : `<div class="empty-state">Todavía no hay ventas. Cargá la primera en "Cargar ventas".</div>`}
    </div>
    ${tipos ? `<div class="grid cols-2 section">${tipos}</div>` : ""}
    <div class="section">
      <h3 class="section-title">Pagos recibidos</h3>
      ${M.pagos.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Forma</th><th>Detalle</th><th class="num">Bs</th></tr></thead>
        <tbody>${filasP}</tbody>
        <tfoot><tr><td>Total pagado</td><td></td><td></td><td class="num">${vmEntero(M.pagado)}</td></tr>
          <tr><td>Por cobrar</td><td></td><td></td><td class="num">${vmEntero(M.saldo)}</td></tr></tfoot>
      </table></div>` : `<div class="empty-state">Todavía no hay pagos. Cargalos en "Cargar pagos".</div>`}
    </div>`;
  body.querySelector("#vmPng").addEventListener("click", vmBajarImagen);
  body.querySelector("#vmXls").addEventListener("click", vmBajarExcel);
}

function vmRenderVentas(body, M) {
  const sigNum = (STATE.ventasMatadero || []).reduce((m, l) => Math.max(m, Number(l.venta) || 0), 0) + 1;
  const hoy = new Date().toISOString().slice(0, 10);
  const filas = M.ventas.map(v => v.lineas.map((l, i) => `
      <tr>
        <td>${i === 0 ? `<b>Venta ${v.n}</b>` : ""}</td><td>${fmtDate(l.fecha)}</td><td>${VM_TIPOS[l.tipo] || escapeHtml(l.tipo)}</td>
        <td class="num">${fmtNum(l.res)}</td><td class="num">${fmtNum(l.kg)}</td><td class="num">${vmProm(Number(l.kg) || 0, Number(l.res) || 0)}</td>
        <td class="num">${fmtNum(l.precio)}</td>
        <td class="num">${vmFlete(l) ? "−" + vmEntero(vmFlete(l)) : "–"}</td>
        <td class="num">${vmEntero(vmNeto(l))}</td>
        <td>${escapeHtml([l.origen ? "Origen: " + l.origen : "", l.fleteDesc ? "Flete " + l.fleteDesc : "", l.obs].filter(Boolean).join(" · "))}</td>
        <td><div class="row-actions"><button class="danger" data-vmdel="${l.id}">Borrar</button></div></td>
      </tr>`).join("")).join("");
  body.innerHTML = `
    <div class="card form-card">
      <h3 class="section-title">Agregar venta</h3>
      <form id="vmFormV">
        <div class="form-grid">
          <div class="field"><label for="vmNum">Venta Nº</label><input id="vmNum" type="number" min="1" step="1" value="${sigNum}" required></div>
          <div class="field"><label for="vmFecha">Fecha</label><input id="vmFecha" type="date" value="${hoy}"></div>
          <div class="field"><label for="vmTipo">Tipo</label><select id="vmTipo"><option value="V">Vaca</option><option value="N">Novillo</option></select></div>
          <div class="field"><label for="vmRes">Nº res</label><input id="vmRes" type="number" min="1" step="1" required></div>
          <div class="field"><label for="vmKg">Kg total</label><input id="vmKg" type="number" min="0" step="0.1" required></div>
          <div class="field"><label for="vmPrecio">Bs/kg</label><input id="vmPrecio" type="number" min="0" step="0.01" value="42" required></div>
          <div class="field"><label for="vmOrigen">Origen de las vacas</label><input id="vmOrigen" type="text" placeholder="Ej. Gonzalo"></div>
          <div class="field"><label for="vmFlete">Flete (Bs, se descuenta)</label><input id="vmFlete" type="number" min="0" step="0.01" placeholder="0"></div>
          <div class="field"><label for="vmFleteDesc">Detalle del flete</label><input id="vmFleteDesc" type="text" placeholder="Ej. San Antonio – Riberalta"></div>
          <div class="field"><label for="vmObs">Observación</label><input id="vmObs" type="text"></div>
        </div>
        <div class="muted" id="vmPrev" style="font-size:12.5px;margin-bottom:10px">Si una venta tiene vacas y novillos, cargá una línea por tipo con el mismo Nº de venta.</div>
        <div class="form-actions"><button class="btn" type="submit">Agregar venta</button></div>
      </form>
    </div>
    ${M.ventas.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Venta</th><th>Fecha</th><th>Tipo</th><th class="num">Res</th><th class="num">Kg</th><th class="num">Prom kg</th><th class="num">Bs/kg</th><th class="num">Flete</th><th class="num">Neto Bs</th><th>Detalle</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>` : `<div class="empty-state">Todavía no hay ventas cargadas.</div>`}`;

  const f = body.querySelector("#vmFormV");
  const prev = () => {
    const r = parseFloat(f.vmRes.value), k = parseFloat(f.vmKg.value), p = parseFloat(f.vmPrecio.value), fl = parseFloat(f.vmFlete.value) || 0;
    if (r > 0 && k > 0) body.querySelector("#vmPrev").textContent = `Promedio ${vmProm(k, r)} kg por res · ${p > 0 ? fmtMoney(k * p - fl) + (fl ? " neto (con flete)" : "") : "falta precio"}`;
  };
  ["vmRes", "vmKg", "vmPrecio", "vmFlete"].forEach(id => f[id].addEventListener("input", prev));
  f.addEventListener("submit", e => {
    e.preventDefault();
    crudAdd("ventasMatadero", {
      venta: parseInt(f.vmNum.value, 10), fecha: f.vmFecha.value, tipo: f.vmTipo.value,
      res: parseInt(f.vmRes.value, 10), kg: parseFloat(f.vmKg.value), precio: parseFloat(f.vmPrecio.value),
      flete: parseFloat(f.vmFlete.value) || 0, fleteDesc: f.vmFleteDesc.value.trim(),
      origen: f.vmOrigen.value.trim(), obs: f.vmObs.value.trim()
    });
    refreshCurrentView();
  });
  body.querySelectorAll("[data-vmdel]").forEach(b => b.addEventListener("click", () => {
    if (!confirm("¿Borrar esta línea de venta?")) return;
    crudDelete("ventasMatadero", b.dataset.vmdel);
    refreshCurrentView();
  }));
}

function vmRenderPagos(body, M) {
  const hoy = new Date().toISOString().slice(0, 10);
  const filas = M.pagos.map(p => `
      <tr><td>${fmtDate(p.fecha)}</td><td>${escapeHtml(p.forma || "")}</td><td>${escapeHtml(p.nota || "")}</td>
        <td class="num">${fmtMoney(p.monto)}</td>
        <td><div class="row-actions"><button class="danger" data-vmpdel="${p.id}">Borrar</button></div></td></tr>`).join("");
  body.innerHTML = `
    <div class="card form-card">
      <h3 class="section-title">Agregar pago</h3>
      <form id="vmFormP">
        <div class="form-grid">
          <div class="field"><label for="vmpFecha">Fecha</label><input id="vmpFecha" type="date" value="${hoy}"></div>
          <div class="field"><label for="vmpMonto">Monto (Bs)</label><input id="vmpMonto" type="number" min="0" step="0.01" required></div>
          <div class="field"><label for="vmpForma">Forma</label><select id="vmpForma">${VM_FORMAS.map(x => `<option>${x}</option>`).join("")}</select></div>
          <div class="field"><label for="vmpNota">Detalle (quién pagó)</label><input id="vmpNota" type="text"></div>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Agregar pago</button></div>
      </form>
    </div>
    ${M.pagos.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Forma</th><th>Detalle</th><th class="num">Monto</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr><td>Total pagado</td><td></td><td></td><td class="num">${fmtMoney(M.pagado)}</td><td></td></tr></tfoot>
    </table></div>` : `<div class="empty-state">Todavía no hay pagos cargados.</div>`}`;
  const f = body.querySelector("#vmFormP");
  f.addEventListener("submit", e => {
    e.preventDefault();
    const monto = parseFloat(f.vmpMonto.value);
    if (!(monto > 0)) return;
    crudAdd("pagosMatadero", { fecha: f.vmpFecha.value, monto, forma: f.vmpForma.value, nota: f.vmpNota.value.trim() });
    refreshCurrentView();
  });
  body.querySelectorAll("[data-vmpdel]").forEach(b => b.addEventListener("click", () => {
    if (!confirm("¿Borrar este pago?")) return;
    crudDelete("pagosMatadero", b.dataset.vmpdel);
    refreshCurrentView();
  }));
}

/* ---------------- descargas ---------------- */
function vmDescargar(blob, nombre) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function vmNombreArchivo(ext) { return `ventas-matadero-los-cepes-${new Date().toISOString().slice(0, 10)}.${ext}`; }

function vmBajarImagen() {
  const M = calcVentasMatadero(STATE);
  const W = 1080, P = 48, RH = 60;
  const C = { bg: "#f6f5ef", fg: "#1f2620", mu: "#66705f", ln: "#dcdccf", ac: "#2f6b3a", acs: "#e3eedf", due: "#9a3b1f", dues: "#f6e3d8", wh: "#ffffff" };
  const nV = M.ventas.reduce((s, v) => s + 1 + v.fletes.length, 0);
  const H = 250 + (36 + RH * (nV + 2) + 44) + (36 + RH * (M.pagos.length + 2) + 44) + 36 + 170 + 24 + 170 + 40;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const F = (w, s) => `${w} ${s}px system-ui,"Segoe UI",Roboto,Arial,sans-serif`;
  const T = (t, x, y, f, col, al = "left") => { g.font = f; g.fillStyle = col; g.textAlign = al; g.textBaseline = "middle"; g.fillText(String(t), x, y); };
  const caja = (x, y, w, h, fill, stroke, lw = 2) => {
    g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, 14); else g.rect(x, y, w, h);
    if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
  };
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  let y = 64;
  T(`${(STATE.meta.nombreEstancia || "Estancia Los Cepes").toUpperCase()} · VENTAS A MATADERO`, P, y, F(600, 26), C.mu); y += 56;
  T("Ventas de vacas a matadero", P, y, F(700, 48), C.fg); y += 56;
  T(`Matadero: Sonneschein 9  ·  V = vaca, N = novillo  ·  al ${new Date().toLocaleDateString("es-BO")}`, P, y, F(400, 26), C.mu); y += 62;

  function tabla(titulo, cols, xs, al, filas, total) {
    T(titulo, P, y, F(700, 30), C.fg); y += 36;
    const top = y, h = RH * (filas.length + 2);
    caja(P, top, W - 2 * P, h, C.wh, C.ln);
    cols.forEach((c, i) => T(c, xs[i], y + RH / 2, F(600, 26), C.mu, al[i] === "r" ? "right" : "left")); y += RH;
    filas.forEach(f => {
      g.fillStyle = C.ln; g.fillRect(P, y, W - 2 * P, 2);
      f.cells.forEach((v, i) => { if (v !== "") T(v, xs[i], y + RH / 2, F(400, f.small ? 27 : 30), f.col || C.fg, al[i] === "r" ? "right" : "left"); });
      y += RH;
    });
    g.fillStyle = C.acs; g.fillRect(P + 2, y, W - 2 * P - 4, RH - 2); g.fillStyle = C.fg; g.fillRect(P, y, W - 2 * P, 3);
    total.forEach((v, i) => { if (v !== "") T(v, xs[i], y + RH / 2, F(700, 30), C.fg, al[i] === "r" ? "right" : "left"); });
    y = top + h + 44;
  }
  const filasV = [];
  M.ventas.forEach(v => {
    filasV.push({ cells: [v.n, v.fecha, v.resTxt + (v.origen ? ` (${v.origen})` : ""), vmProm(v.kg, v.res), vmEntero(v.kg), vmEntero(v.bruto)] });
    v.fletes.forEach(f => filasV.push({ cells: ["", f.desc, "", "", "", "−" + vmEntero(f.monto)], col: C.due, small: true }));
  });
  tabla("Ventas", ["Venta", "Fecha", "Res", "Prom kg", "Kg", "Bs"], [P + 24, P + 130, P + 300, P + 640, P + 800, W - P - 24], "lllrrr", filasV,
    ["Total", "", `${M.tot.res} res`, vmProm(M.tot.kg, M.tot.res), vmEntero(M.tot.kg), vmEntero(M.tot.neto)]);
  tabla("Pagos recibidos", ["Fecha", "Forma", "Bs"], [P + 24, P + 220, W - P - 24], "llr",
    M.pagos.map(p => ({ cells: [vmDiaMes(p.fecha), (p.forma || "") + (p.nota ? ` (${p.nota})` : ""), vmEntero(p.monto)] })),
    ["Total", "", vmEntero(M.pagado)]);
  T("Resumen", P, y, F(700, 30), C.fg); y += 36;
  const bw = (W - 2 * P - 24) / 2, bh = 170;
  [["TOTAL NETO", M.tot.neto, C.fg, C.wh], ["PAGADO", M.pagado, C.ac, C.acs]].forEach(([lab, val, col, bgc], i) => {
    const x = P + i * (bw + 24);
    caja(x, y, bw, bh, bgc, C.ln);
    T(lab, x + 24, y + 46, F(600, 26), C.mu); T("Bs " + vmEntero(val), x + 24, y + 112, F(700, 56), col);
  });
  y += bh + 24;
  caja(P, y, W - 2 * P, bh, C.dues, C.due, 3);
  T("POR COBRAR", P + 24, y + 46, F(600, 26), C.due);
  T("Bs " + vmEntero(M.saldo), P + 24, y + 112, F(700, 56), C.due);
  T(`${fmtPct(M.pct)} cobrado`, W - P - 24, y + 100, F(700, 30), C.due, "right");
  cv.toBlob(b => vmDescargar(b, vmNombreArchivo("png")), "image/png");
}

function vmBajarExcel() {
  if (typeof XLSX === "undefined") { alert("No se pudo cargar la librería de Excel. Revisá la conexión e intentá de nuevo."); return; }
  const M = calcVentasMatadero(STATE);
  const wb = XLSX.utils.book_new();
  const r = [
    [`Ventas de vacas a matadero – ${STATE.meta.nombreEstancia || "Estancia Los Cepes"} (matadero: Sonneschein 9)`],
    [`Actualizado al ${new Date().toLocaleDateString("es-BO")}`], [],
    ["Venta", "Fecha", "Res", "Origen", "Prom kg", "Kg", "Bs"]
  ];
  M.ventas.forEach(v => {
    r.push([v.n, v.fecha, v.resTxt, v.origen, v.res ? +(v.kg / v.res).toFixed(1) : "", v.kg, v.bruto]);
    v.fletes.forEach(f => r.push(["", f.desc, "", "", "", "", -f.monto]));
  });
  r.push(["Total neto", "", M.tot.res, "", M.tot.res ? +(M.tot.kg / M.tot.res).toFixed(1) : "", M.tot.kg, M.tot.neto], [],
    ["Pagos recibidos"], ["Fecha", "Forma", "Detalle", "Bs"]);
  M.pagos.forEach(p => r.push([vmDiaMes(p.fecha), p.forma || "", p.nota || "", Number(p.monto) || 0]));
  r.push(["Total pagado", "", "", M.pagado], [], ["Total neto", "", "", M.tot.neto], ["Pagado", "", "", M.pagado],
    ["Por cobrar", "", "", M.saldo], ["% cobrado", "", "", +(M.pct * 100).toFixed(1)]);
  const ws = XLSX.utils.aoa_to_sheet(r);
  ws["!cols"] = [{ wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 18 }, { wch: 9 }, { wch: 9 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, "Resumen");

  const d = [["Venta", "Fecha", "Tipo", "Res", "Kg", "Prom kg", "Bs/kg", "Bruto Bs", "Flete Bs", "Detalle flete", "Neto Bs", "Origen", "Observación"]];
  M.ventas.forEach(v => v.lineas.forEach(l => {
    const c = Number(l.res) || 0, k = Number(l.kg) || 0;
    d.push([l.venta, fmtDate(l.fecha), VM_TIPOS[l.tipo] || l.tipo, c, k, c ? +(k / c).toFixed(1) : "", Number(l.precio) || 0,
      vmBruto(l), vmFlete(l), l.fleteDesc || "", vmNeto(l), l.origen || "", l.obs || ""]);
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(d), "Ventas detalle");

  const p = [["Fecha", "Forma", "Detalle", "Bs"]];
  M.pagos.forEach(x => p.push([fmtDate(x.fecha), x.forma || "", x.nota || "", Number(x.monto) || 0]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(p), "Pagos");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  vmDescargar(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), vmNombreArchivo("xlsx"));
}

/* ---------------- registro en el router ---------------- */
VIEW_TITLES["ventas-matadero"] = "Ventas a Matadero";
VIEW_RENDERERS["ventas-matadero"] = renderVentasMatadero;
