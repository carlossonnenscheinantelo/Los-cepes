/* ==========================================================================
   charts.js — helpers finos sobre Chart.js (crear/destruir por canvas id)
   ========================================================================== */

const CHART_REGISTRY = {};

function destroyChart(id) {
  if (CHART_REGISTRY[id]) {
    CHART_REGISTRY[id].destroy();
    delete CHART_REGISTRY[id];
  }
}

const CHART_COLORS = {
  green: "#2c7a4f",
  greenSoft: "rgba(44,122,79,.18)",
  red: "#b5332a",
  redSoft: "rgba(181,51,42,.18)",
  amber: "#b8860b",
  blue: "#2461a8",
  palette: ["#2c7a4f","#3d9963","#b8860b","#2461a8","#b5332a","#7a5b06","#5b6b62","#173d2c","#9fd8b8","#8f2620"]
};

function fmtMoney(n) {
  n = Number(n) || 0;
  return "Bs " + n.toLocaleString("es-BO", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtMoney2(n) {
  n = Number(n) || 0;
  return "Bs " + n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  n = Number(n) || 0;
  return (n * 100).toLocaleString("es-BO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function fmtNum(n) {
  n = Number(n) || 0;
  return n.toLocaleString("es-BO", { maximumFractionDigits: 2 });
}

function chartLineIngresosEgresos(canvasId, er) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      labels: MESES_LABEL,
      datasets: [
        { label: "Ingresos", data: er.totalIngresosMes, borderColor: CHART_COLORS.green, backgroundColor: CHART_COLORS.greenSoft, fill: true, tension: .3 },
        { label: "Costos", data: er.totalCostosDirectosMes.map((v,i)=>v+er.totalEstructuraMes[i]), borderColor: CHART_COLORS.red, backgroundColor: CHART_COLORS.redSoft, fill: true, tension: .3 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: "bottom" } }, scales: { y: { ticks: { callback: v => fmtMoney(v) } } } }
  });
}

function chartResultadoMensual(canvasId, er) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: MESES_LABEL,
      datasets: [{
        label: "Resultado del mes",
        data: er.resultadoMes,
        backgroundColor: er.resultadoMes.map(v => v >= 0 ? CHART_COLORS.green : CHART_COLORS.red)
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => fmtMoney(v) } } } }
  });
}

function chartCostosPorRubro(canvasId, rubros) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const top = rubros.slice(0, 8);
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map(r => r.nombre),
      datasets: [{ label: "Importe año (Bs)", data: top.map(r => r.importe), backgroundColor: CHART_COLORS.palette }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { callback: v => fmtMoney(v) } } }
    }
  });
}

function chartRodeoPorCategoria(canvasId, inv) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const filas = inv.filas.filter(f => f.stockActual > 0);
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: filas.map(f => f.categoria),
      datasets: [{ data: filas.map(f => f.stockActual), backgroundColor: CHART_COLORS.palette }]
    },
    options: { responsive: true, plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } } }
  });
}

function chartFlujoCaja(canvasId, flujo) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      labels: MESES_LABEL,
      datasets: [{ label: "Saldo acumulado", data: flujo.saldoFinalAcumulado, borderColor: CHART_COLORS.blue, backgroundColor: "rgba(36,97,168,.15)", fill: true, tension: .25 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => fmtMoney(v) } } } }
  });
}

/** Kardex por producto de Almacén: evolución del precio unitario de compra en el tiempo. */
function chartKardexPrecio(canvasId, compras) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHART_REGISTRY[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      labels: compras.map(c => c.fecha),
      datasets: [{ label: "Precio unitario (Bs)", data: compras.map(c => c.precioUnitario), borderColor: CHART_COLORS.amber, backgroundColor: "rgba(184,134,11,.15)", fill: true, tension: .2, pointRadius: 4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => fmtMoney2(v) } } } }
  });
}
