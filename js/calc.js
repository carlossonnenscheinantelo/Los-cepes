/* ==========================================================================
   calc.js — motor de cálculo (replica las fórmulas del Excel).
   Todas las funciones son puras: reciben `state` y devuelven datos derivados,
   nunca mutan el estado.
   ========================================================================== */

const MESES_LABEL = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];

function monthYear(fechaISO) {
  if (!fechaISO) return { m: null, y: null };
  const [y, m] = fechaISO.split("-").map(Number);
  return { m, y };
}

function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function pct(part, total) { return total ? part / total : 0; }

/**
 * Devuelve la cola de lotes de un producto de Almacén, en orden FIFO (primero
 * en entrar, primero en salir), tal como queda DESPUÉS de replicar todos los
 * movimientos ya guardados (compras que agregan un lote nuevo, consumos que
 * descuentan de los lotes más viejos primero). Cada lote conserva su propio
 * precio de venta al trabajador (`precioVentaLote`, cargado en la compra) —
 * si una compra vieja no tiene ese dato (porque es anterior a esta función),
 * usa como respaldo el "precio de venta por defecto" del producto.
 * Devuelve: [{ movId, cantidadRestante, precioVenta, precioUnitario }]
 */
function calcularColaLotesFIFO(state, productoId) {
  const producto = (state.almacenProductos || []).find(p => p.id === productoId);
  const precioDefecto = producto ? (Number(producto.precioVentaTrabajador) || 0) : 0;
  const movs = (state.almacenMovimientos || [])
    .filter(m => m.productoId === productoId)
    .slice()
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || "") || String(a.id||"").localeCompare(String(b.id||"")));

  const cola = [];
  movs.forEach(m => {
    const cant = Number(m.cantidad) || 0;
    if (m.tipo === "compra" || (m.tipo === "ajuste" && cant > 0)) {
      cola.push({
        movId: m.id,
        cantidadRestante: Math.abs(cant),
        precioVenta: (m.precioVentaLote != null && m.precioVentaLote !== "") ? Number(m.precioVentaLote) : precioDefecto,
        precioUnitario: Number(m.precioUnitario) || 0
      });
    } else {
      // consumo, consumo_trabajador, o ajuste negativo: descuenta FIFO de los lotes más viejos.
      let restante = Math.abs(cant);
      while (restante > 0 && cola.length) {
        const lote = cola[0];
        const tomar = Math.min(lote.cantidadRestante, restante);
        lote.cantidadRestante = round2(lote.cantidadRestante - tomar);
        restante = round2(restante - tomar);
        if (lote.cantidadRestante <= 0) cola.shift();
      }
    }
  });
  return cola;
}

/**
 * Calcula cuánto habría que cobrarle a un trabajador (y cuánto costó, para
 * margen) por una cantidad nueva a consumir de un producto, siguiendo FIFO:
 * toma primero de los lotes más viejos con su propio precio de venta. Si la
 * cantidad pedida supera lo que hay en los lotes con precio propio, lo que
 * falta se cobra al "precio de venta por defecto" del producto.
 */
function calcularMontoConsumoFIFO(state, productoId, cantidadAConsumir) {
  const cola = calcularColaLotesFIFO(state, productoId);
  let restante = Number(cantidadAConsumir) || 0;
  let monto = 0, costo = 0;
  const detalle = [];
  for (const lote of cola) {
    if (restante <= 0) break;
    const tomar = Math.min(lote.cantidadRestante, restante);
    monto += tomar * lote.precioVenta;
    costo += tomar * lote.precioUnitario;
    detalle.push({ movId: lote.movId, cantidad: tomar, precioVenta: lote.precioVenta });
    restante = round2(restante - tomar);
  }
  if (restante > 0) {
    const producto = (state.almacenProductos || []).find(p => p.id === productoId);
    const precioDefecto = producto ? (Number(producto.precioVentaTrabajador) || 0) : 0;
    monto += restante * precioDefecto;
    detalle.push({ movId: null, cantidad: restante, precioVenta: precioDefecto });
  }
  return { monto: round2(monto), costo: round2(costo), detalle };
}

/**
 * Cuenta los días entre dos fechas ISO (incluyendo ambos extremos) con la
 * convención boliviana de "mes de 30 días" — la misma que usa el Ministerio
 * de Trabajo para liquidaciones y aguinaldo: todo mes cuenta como si tuviera
 * 30 días, sin importar si tiene 28, 29, 30 o 31.
 */
function diasBase30(fechaDesdeISO, fechaHastaISO) {
  const [y1, m1, d1] = fechaDesdeISO.split("-").map(Number);
  const [y2, m2, d2] = fechaHastaISO.split("-").map(Number);
  const dd1 = Math.min(d1, 30), dd2 = Math.min(d2, 30);
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (dd2 - dd1) + 1; // +1 incluye el día final
}

/**
 * Prorratea un monto mensual (ej. haber básico) para un período [desde, hasta],
 * considerando la fecha de ingreso del trabajador: si ingresó después de "desde",
 * el período efectivo arranca en su fecha de ingreso; si ingresó después de
 * "hasta", no le corresponde nada en ese período. Si no tiene fecha de ingreso
 * cargada, se asume que ya estaba trabajando desde antes (sin prorrateo).
 * Usa la tarifa diaria = montoMensual/30 (convención de mes de 30 días).
 */
function haberProrrateado(montoMensual, fechaIngreso, desde, hasta) {
  if (!desde || !hasta) return montoMensual;
  const efectivoDesde = (fechaIngreso && fechaIngreso > desde) ? fechaIngreso : desde;
  if (efectivoDesde > hasta) return 0;
  const diasTrabajados = Math.max(0, diasBase30(efectivoDesde, hasta));
  return (montoMensual / 30) * diasTrabajados;
}

/**
 * Calcula el haber básico ACUMULADO de un trabajador desde su fecha de ingreso
 * hasta una fecha de corte (por defecto, hoy) — pensado para saber "cuánto se
 * le debe a la fecha" sumando sueldo mes a mes: el MES DE INGRESO se prorratea
 * por día (de su fecha de ingreso al día 30 de ese mismo mes, convención
 * boliviana de mes de 30 días — igual que `haberProrrateado`/`diasBase30`),
 * y CADA MES SIGUIENTE se suma COMPLETO apenas arranca su día 1 — no se
 * prorratea la cola del mes en curso, el sueldo del mes se da por devengado
 * íntegro desde el 1 (a diferencia de `haberProrrateado`, que prorratea todo
 * el rango [desde,hasta] de forma continua día a día).
 * Devuelve null si no hay fecha de ingreso cargada (no hay desde cuándo sumar).
 */
function haberAcumuladoDesdeIngreso(montoMensual, fechaIngreso, hastaISO) {
  if (!fechaIngreso) return null;
  const hasta = hastaISO || new Date().toISOString().slice(0, 10);
  if (fechaIngreso > hasta) return 0;
  const [yIng, mIng, dIng] = fechaIngreso.split("-").map(Number);
  const [yHasta, mHasta] = hasta.split("-").map(Number);
  // Días del mes de ingreso que le corresponden: de su día de ingreso al día 30 (inclusive).
  const diasPrimerMes = Math.max(0, 30 - Math.min(dIng, 30) + 1);
  const primerMes = round2((montoMensual / 30) * diasPrimerMes);
  // Meses completos ya arrancados después del mes de ingreso (cada uno cuenta entero).
  const mesesTotalesIngreso = yIng * 12 + (mIng - 1);
  const mesesTotalesHasta = yHasta * 12 + (mHasta - 1);
  const mesesCompletos = Math.max(0, mesesTotalesHasta - mesesTotalesIngreso);
  return round2(primerMes + mesesCompletos * montoMensual);
}

const MESES_LARGO = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

/**
 * Desglosa el haber básico de un período [desde, hasta] mes por mes, para
 * mostrar en la planilla imprimible CUÁNDO se devengó cada sueldo (no solo
 * el total del período) — así el trabajador ve su ingreso como una planilla
 * de sueldos real: un renglón por mes trabajado, con su importe.
 * Reutiliza `haberProrrateado` acotado a cada mes calendario, por lo que la
 * suma de los renglones da exactamente el mismo total que `haberProrrateado`
 * sobre el rango completo (misma convención de mes de 30 días).
 * Devuelve [{ anio, mes, mesLabel, desde, hasta, prorrateado, monto }], solo
 * con los meses donde corresponde algún importe (> 0).
 */
function desglosarHaberPorMes(montoMensual, fechaIngreso, desde, hasta) {
  if (!desde || !hasta || hasta < desde) return [];
  const filas = [];
  let [y, m] = desde.split("-").map(Number);
  const [yFin, mFin] = hasta.split("-").map(Number);
  while (y < yFin || (y === yFin && m <= mFin)) {
    const mm = String(m).padStart(2, "0");
    const inicioMes = `${y}-${mm}-01`;
    const finMesTope = `${y}-${mm}-30`;
    // Recorte por el período impreso (desde/hasta elegidos al imprimir).
    const limiteDesde = inicioMes > desde ? inicioMes : desde;
    const mesHasta = finMesTope < hasta ? finMesTope : hasta;
    // Si la fecha de ingreso cae dentro de este mes, el arranque real es esa
    // fecha (no el 1° del mes) — así el renglón muestra el rango efectivamente
    // trabajado, no un mes "completo" con un importe que no cuadra a simple vista.
    const porIngreso = !!(fechaIngreso && fechaIngreso > limiteDesde);
    const mesDesde = porIngreso ? fechaIngreso : limiteDesde;
    if (mesDesde <= mesHasta) {
      const monto = round2(haberProrrateado(montoMensual, fechaIngreso, mesDesde, mesHasta));
      if (monto > 0) {
        filas.push({
          anio: y, mes: m, mesLabel: `${MESES_LARGO[m - 1]} ${y}`,
          desde: mesDesde, hasta: mesHasta,
          prorrateado: porIngreso,
          monto
        });
      }
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return filas;
}

/* ---------------------------- SUELDOS ---------------------------- */
function calcSueldos(state) {
  const aporte = state.meta.aportePatronal || 0;
  const anio = state.meta.anio;
  const filas = state.empleados.map(e => {
    const cant = Number(e.cantidad) || 0;
    const hb = Number(e.haberBasico) || 0;
    const bono = Number(e.bonoProd) || 0;
    const totalMensual = cant * (hb + bono);        // costo de un mes completo "en régimen"
    const aporteAfp = cant * hb * aporte;            // aporte de un mes completo
    const costoTotalMes = totalMensual + aporteAfp;  // costo de un mes completo

    // Costo proyectado del año en curso (state.meta.anio), prorrateando por la
    // fecha de ingreso: antes de ingresar no cuenta nada, el mes de ingreso se
    // prorratea por día (mes de 30 días), y de ahí en más cuenta el mes completo.
    const costoMensualAnio = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      const desdeMes = `${anio}-${mm}-01`;
      // Convención de mes de 30 días: el mes siempre "cierra" el día 30 para este cálculo
      // (sin importar si el mes calendario real tiene 28, 29, 30 o 31 días), así un mes
      // completo sin fecha de ingreso de por medio siempre da el costo íntegro del mes.
      const hastaMes = `${anio}-${mm}-30`;
      costoMensualAnio.push(haberProrrateado(costoTotalMes, e.fechaIngreso, desdeMes, hastaMes));
    }
    const costoAnioSinAguinaldo = sum(costoMensualAnio);
    // Meses trabajados en el año (fracción), derivado del mismo prorrateo mensual.
    const mesesTrabajados = costoTotalMes > 0 ? costoAnioSinAguinaldo / costoTotalMes : 0;
    // Aguinaldo (13er sueldo) prorrateado según los meses efectivamente trabajados en el año.
    const aguinaldoProrrateado = costoTotalMes * (mesesTrabajados / 12);
    const costoAnual = costoAnioSinAguinaldo + aguinaldoProrrateado;

    return {
      ...e, cantidad: cant, haberBasico: hb, bonoProd: bono,
      totalMensual, aporteAfp, costoTotalMes,
      mesesTrabajados, costoMensualAnio, aguinaldoProrrateado, costoAnual
    };
  });
  return {
    filas,
    totalMensual: sum(filas.map(f => f.totalMensual)),
    totalAporte: sum(filas.map(f => f.aporteAfp)),
    totalCostoMes: sum(filas.map(f => f.costoTotalMes)),
    totalCostoAnual: sum(filas.map(f => f.costoAnual)),
    totalAguinaldoAnio: sum(filas.map(f => f.aguinaldoProrrateado))
  };
}

/* ---------------------------- GASTOS FIJOS ---------------------------- */
function calcGastosFijos(state) {
  const totalMensual = sum(state.gastosFijos.map(g => g.importeMensual));
  const filas = state.gastosFijos.map(g => {
    const importeMensual = Number(g.importeMensual) || 0;
    return { ...g, importeMensual, importeAnual: importeMensual * 12, pct: pct(importeMensual, totalMensual) };
  });
  return { filas, totalMensual, totalAnual: totalMensual * 12 };
}

/* ---------------------------- GASTOS VARIABLES ---------------------------- */
function calcGastosVariables(state) {
  const filas = state.gastosVariables.map(g => {
    const cant = Number(g.cantidadMes) || 0;
    const precio = Number(g.precioUnit) || 0;
    return { ...g, cantidadMes: cant, precioUnit: precio, importeMes: cant * precio };
  });
  return { filas, total: sum(filas.map(f => f.importeMes)) };
}

/* ---------------------------- ACTIVOS FIJOS / DEPRECIACIÓN ---------------------------- */
function calcActivosFijos(state) {
  const filas = state.activosFijos.map(a => {
    const valor = Number(a.valor) || 0;
    const vidaUtil = a.vidaUtil ? Number(a.vidaUtil) : 0;
    const deprecAnual = vidaUtil > 0 ? valor / vidaUtil : 0;
    return { ...a, valor, deprecAnual };
  });
  return { filas, totalValor: sum(filas.map(f => f.valor)), totalDeprecAnual: sum(filas.map(f => f.deprecAnual)) };
}

/* ---------------------------- GANADO — INVENTARIO (método CREA) ---------------------------- */
function calcGanadoInventario(state) {
  const filas = state.categoriasGanado.map(cat => {
    const base = state.inventarioCreaCategorias.find(r => r.categoriaId === cat.id) || { cabezas: 0, precioBsCab: 0, pesoProm: 0 };
    const stockInicial = Number(base.cabezas) || 0;
    const precioBsCab = Number(base.precioBsCab) || 0;
    const movs = state.ganadoMovimiento.filter(m => (m.categoria || "").trim().toLowerCase() === cat.nombre.trim().toLowerCase());
    // La ENTRADA "compra inicial" generada desde Levantamiento (CREA) (`base.entradaMovId`)
    // representa el MISMO rodeo que ya está contado en `stockInicial` (es el asiento contable
    // de esa compra, no una entrada de cabezas nueva) — se excluye por completo (0 cabezas).
    // Cualquier OTRA compra (ENTRADA real posterior) puede tener animales individuales
    // vinculados por `compraMovId` (se les dio número de caravana al comprarlos) — esos
    // animales quedan contados EXCLUSIVAMENTE por el registro individual de acá en más
    // (mientras están ACTIVO cuentan en `stockInicial`; el día que se venden, la SALIDA los
    // excluye vía `ventaId`, ver más abajo) — así que NUNCA se cuentan de nuevo acá, ni
    // siquiera después de venderse (para eso está la exclusión del lado de la SALIDA). Solo
    // se suma como "entrada" el remanente que JAMÁS se numeró (compras cargadas solo en
    // bloque, sin caravana por cabeza) — por eso NO se filtra por estado acá: se cuenta
    // cualquier animal alguna vez vinculado a esta compra, esté ACTIVO o ya vendido/muerto.
    const entradas = sum(movs.filter(m => m.tipo === "ENTRADA").map(m => {
      if (m.id === base.entradaMovId) return 0;
      const cabezasMov = Number(m.cabezas) || 0;
      const vinculadas = state.animales.filter(a => a.compraMovId === m.id).length;
      return Math.max(0, cabezasMov - vinculadas);
    }));
    const nacimientos = sum(movs.filter(m => m.tipo === "NACIMIENTO").map(m => m.cabezas));
    // Si las cabezas de una SALIDA ya están vinculadas a animales individuales (ventaId),
    // esos animales ya están marcados VENDIDO y por lo tanto YA salieron de "stockInicial"
    // (que se recalcula desde los animales ACTIVO). No hay que restarlas de nuevo acá —
    // si no fuera así, se restarían dos veces. Solo se resta lo NO vinculado (ventas
    // viejas cargadas antes de existir este vínculo, o si vinculaste menos animales que
    // las cabezas cargadas en el movimiento).
    const salidas = sum(movs.filter(m => m.tipo === "SALIDA").map(m => {
      const cabezasMov = Number(m.cabezas) || 0;
      const vinculadas = state.animales.filter(a => a.ventaId === m.id).length;
      return vinculadas > 0 ? Math.max(0, cabezasMov - vinculadas) : cabezasMov;
    }));
    const muertes = sum(movs.filter(m => m.tipo === "MUERTE").map(m => m.cabezas));
    const stockActual = stockInicial + entradas + nacimientos - salidas - muertes;
    const coefEV = Number(cat.coefEV) || 0;
    // "función" clasifica el activo para el Balance (NIC 41 — activos biológicos): la hacienda
    // reproductora (cría) se lleva como activo NO corriente; la de engorde/venta, como bien de
    // cambio (activo corriente). Default "Venta (engorde)" para categorías sin función cargada.
    const funcion = cat.funcion || "Venta (engorde)";
    return {
      categoriaId: cat.id, categoria: cat.nombre, funcion, stockInicial, entradas, nacimientos, salidas, muertes,
      stockActual, coefEV, evActual: stockActual * coefEV, precioBsCab,
      valorActual: stockActual * precioBsCab, valorInicial: stockInicial * precioBsCab
    };
  });
  const filasCria = filas.filter(f => f.funcion === "Cría (reproductor)");
  const filasVenta = filas.filter(f => f.funcion !== "Cría (reproductor)");
  return {
    filas,
    totalStockInicial: sum(filas.map(f => f.stockInicial)),
    totalEntradas: sum(filas.map(f => f.entradas)),
    totalNacimientos: sum(filas.map(f => f.nacimientos)),
    totalSalidas: sum(filas.map(f => f.salidas)),
    totalMuertes: sum(filas.map(f => f.muertes)),
    totalStockActual: sum(filas.map(f => f.stockActual)),
    totalEV: sum(filas.map(f => f.evActual)),
    totalValorActual: sum(filas.map(f => f.valorActual)),
    totalValorInicial: sum(filas.map(f => f.valorInicial)),
    // Split para el Balance: hacienda reproductora (activo no corriente) vs. de venta/engorde
    // (bien de cambio, activo corriente) — ver calcBalance.
    totalValorActualCria: sum(filasCria.map(f => f.valorActual)),
    totalValorActualVenta: sum(filasVenta.map(f => f.valorActual)),
    totalValorInicialCria: sum(filasCria.map(f => f.valorInicial)),
    totalValorInicialVenta: sum(filasVenta.map(f => f.valorInicial)),
    cargaAnimalEVporHa: pct(sum(filas.map(f => f.evActual)), Number(state.inventarioCrea.superficieHa) || 0)
  };
}

/**
 * Calcula la rentabilidad de cada venta (movimiento SALIDA de Ganado) a partir de
 * los animales individuales vinculados a esa venta (animales.ventaId === movimiento.id).
 * Si esos animales tienen un `costoCompra` real (porque se los numeró con su caravana al
 * comprarlos vía `registrarAnimalesDeCompra`), se usa ESE costo real por animal — mucho más
 * preciso para evaluar el negocio puntual de una compra-engorde-venta. Si no tienen costo
 * real cargado (ventas viejas, o animales que nunca se numeraron al comprar), se completa
 * con el precio Bs/cabeza promedio de la categoría (Levantamiento CREA) como respaldo — se
 * puede mezclar: algunos animales de una misma venta con costo real y otros con el promedio.
 * Si no hay ningún animal vinculado a la venta, se usa la cantidad de cabezas del movimiento
 * y el precio promedio de categoría para poder estimar la rentabilidad igual (ej. ventas
 * viejas cargadas antes de tener este vínculo).
 */
function calcRentabilidadVentas(state) {
  const salidas = state.ganadoMovimiento.filter(m => m.tipo === "SALIDA");
  return salidas.map(m => {
    const animalesVinculados = state.animales.filter(a => a.ventaId === m.id);
    const cabezasVinculadas = animalesVinculados.length;
    const cabezas = cabezasVinculadas > 0 ? cabezasVinculadas : (Number(m.cabezas) || 0);
    const cat = state.categoriasGanado.find(c => c.nombre.trim().toLowerCase() === (m.categoria || "").trim().toLowerCase());
    const base = cat ? (state.inventarioCreaCategorias.find(r => r.categoriaId === cat.id) || {}) : {};
    const costoUnitario = Number(base.precioBsCab) || 0;
    const montoVenta = montoTotalGanadoRow(m);
    const fleteTotal = Number(m.fleteTotal) || 0;

    const animalesConCostoReal = animalesVinculados.filter(a => a.costoCompra != null && a.costoCompra !== "");
    const usaCostoReal = animalesConCostoReal.length > 0;
    const costoAnimales = usaCostoReal
      ? sum(animalesConCostoReal.map(a => Number(a.costoCompra) || 0)) + (cabezas - animalesConCostoReal.length) * costoUnitario
      : costoUnitario * cabezas;

    const costoTotal = costoAnimales + fleteTotal;
    const rentabilidad = montoVenta - costoTotal;
    const rentabilidadUnitaria = cabezas > 0 ? rentabilidad / cabezas : 0;
    return {
      movimientoId: m.id, fecha: m.fecha, categoria: m.categoria, comprador: m.comprador, destino: m.destino,
      cabezasVinculadas, cabezasMovimiento: Number(m.cabezas) || 0, cabezas,
      montoVenta, costoUnitario, costoAnimales, fleteTotal, costoTotal, rentabilidad, rentabilidadUnitaria,
      usaCostoReal, animalesConCostoReal: animalesConCostoReal.length,
      sinCostoCargado: costoUnitario === 0 && !usaCostoReal,
      animales: animalesVinculados.map(a => a.numero)
    };
  });
}

/* ---------------------------- DIARIO por mes / categoría ---------------------------- */
function diarioSumPorCategoriaMes(state, categoriaNombre, anio) {
  const out = new Array(12).fill(0);
  state.diario.forEach(r => {
    if ((r.categoria || "") !== categoriaNombre) return;
    const { m, y } = monthYear(r.fecha);
    if (y === anio && m) out[m - 1] += Number(r.monto) || 0;
  });
  return out;
}
function diarioSumPorTipoMes(state, tipo, anio) {
  const out = new Array(12).fill(0);
  state.diario.forEach(r => {
    if ((r.tipo || "") !== tipo) return;
    const { m, y } = monthYear(r.fecha);
    if (y === anio && m) out[m - 1] += Number(r.monto) || 0;
  });
  return out;
}
/**
 * Monto en Bs de un movimiento de ganado, según su tipo y —para SALIDA— su tipo de venta:
 * "Kilo Vivo" (kgSalida × bsKgSalida), "Kilo Gancho" (kgGanchoSalida × bsKgGanchoSalida)
 * o "Al Bulto" (monto pactado directo, sin base en kg). Nunca mezclar kg de distinta base
 * en un mismo total (ver nota de calcAnalisis): esta función es la única fuente de verdad
 * para "cuántos Bs entraron/salieron" en un movimiento de ganado.
 */
function montoTotalGanadoRow(row) {
  if (row.tipo === "ENTRADA") {
    // "Por Cabeza" (tipoCompra): usado para compras pactadas a precio por cabeza en vez de
    // por kilo vivo — ej. la compra inicial de ganado registrada desde Levantamiento (CREA),
    // que ya carga cabezas y Bs/cabeza por categoría en vez de kilos.
    if (row.tipoCompra === "Por Cabeza") return (Number(row.cabezas) || 0) * (Number(row.bsCabEntrada) || 0);
    return (Number(row.kgEntrada) || 0) * (Number(row.bsKgEntrada) || 0);
  }
  if (row.tipo === "SALIDA") {
    const tv = row.tipoVenta || "Kilo Vivo";
    if (tv === "Kilo Gancho") return (Number(row.kgGanchoSalida) || 0) * (Number(row.bsKgGanchoSalida) || 0);
    if (tv === "Al Bulto") return Number(row.montoTotalSalida) || 0;
    return (Number(row.kgSalida) || 0) * (Number(row.bsKgSalida) || 0); // Kilo Vivo (default, compat con datos viejos)
  }
  return 0; // NACIMIENTO / MUERTE no mueven plata
}

function ganadoSumPorTipoMes(state, tipo, campoTotal, anio) {
  // campoTotal se mantiene por compatibilidad de firma, pero el monto real siempre
  // se calcula con montoTotalGanadoRow (que ya sabe distinguir entrada/salida y tipo de venta).
  const out = new Array(12).fill(0);
  state.ganadoMovimiento.forEach(r => {
    if (tipo && r.tipo !== tipo) return;
    const { m, y } = monthYear(r.fecha);
    if (y !== anio || !m) return;
    out[m - 1] += montoTotalGanadoRow(r);
  });
  return out;
}

const ARR0 = () => new Array(12).fill(0);
function addArr(a, b) { return a.map((v, i) => v + b[i]); }
function sumArr(a) { return sum(a); }

/* ---------------------------- ESTADO DE RESULTADOS ---------------------------- */
function calcEstadoResultado(state, anio) {
  const ventaGanado = ganadoSumPorTipoMes(state, "SALIDA", "salida", anio);
  const ventaSubproductos = diarioSumPorCategoriaMes(state, "Venta de Subproductos", anio);
  const otrosIngresos = diarioSumPorCategoriaMes(state, "Otros Ingresos", anio);

  const inv = calcGanadoInventario(state);
  const variacionInventario = inv.totalValorActual - inv.totalValorInicial;

  const totalIngresosMes = addArr(addArr(ventaGanado, ventaSubproductos), otrosIngresos);
  const totalIngresosAnio = sumArr(totalIngresosMes) + variacionInventario;

  const compraGanado = ganadoSumPorTipoMes(state, "ENTRADA", "entrada", anio);
  const costosDirectosCats = ["Combustible", "Víveres / Alimentación", "Sanidad Animal", "Suplementos / Nutrición", "Mantenimiento / Repuestos", "Flete / Transporte"];
  const costosDirectosDetalle = costosDirectosCats.map(nombre => ({ nombre, valores: diarioSumPorCategoriaMes(state, nombre, anio) }));

  let totalCostosDirectosMes = addArr(ARR0(), compraGanado);
  costosDirectosDetalle.forEach(c => { totalCostosDirectosMes = addArr(totalCostosDirectosMes, c.valores); });
  const totalCostosDirectosAnio = sumArr(totalCostosDirectosMes);

  const margenBrutoMes = totalIngresosMes.map((v, i) => v - totalCostosDirectosMes[i]);
  const margenBrutoAnio = totalIngresosAnio - totalCostosDirectosAnio; // incluye variación de inventario en ingresos anuales

  const estructuraCats = [
    { nombre: "Sueldos y Salarios", cat: "Sueldos y Salarios" },
    { nombre: "Gastos Fijos (arriendo/seguros/serv.)", cat: "Gastos Fijos (arriendo/seguros/serv.)" },
    { nombre: "Honorarios / Administración", cat: "Honorarios / Administración" },
    { nombre: "Impuestos / Tasas", cat: "Impuestos / Tasas" },
    { nombre: "Otros Egresos", cat: "Otros Egresos" }
  ];
  const estructuraDetalle = estructuraCats.map(e => ({ nombre: e.nombre, valores: diarioSumPorCategoriaMes(state, e.cat, anio) }));

  const activos = calcActivosFijos(state);
  const deprecMensual = activos.totalDeprecAnual / 12;
  const depreciacionMes = new Array(12).fill(deprecMensual);

  let totalEstructuraMes = addArr(ARR0(), depreciacionMes);
  estructuraDetalle.forEach(e => { totalEstructuraMes = addArr(totalEstructuraMes, e.valores); });
  const totalEstructuraAnio = sumArr(totalEstructuraMes);

  const resultadoMes = margenBrutoMes.map((v, i) => v - totalEstructuraMes[i]);
  const resultadoAnio = margenBrutoAnio - totalEstructuraAnio;

  const margenNetoMes = resultadoMes.map((v, i) => pct(v, totalIngresosMes[i]));
  const margenBrutoPctMes = margenBrutoMes.map((v, i) => pct(v, totalIngresosMes[i]));

  return {
    anio, ventaGanado, ventaSubproductos, otrosIngresos, variacionInventario,
    totalIngresosMes, totalIngresosAnio,
    compraGanado, costosDirectosDetalle, totalCostosDirectosMes, totalCostosDirectosAnio,
    margenBrutoMes, margenBrutoAnio, margenBrutoPctMes,
    estructuraDetalle, depreciacionMes, totalEstructuraMes, totalEstructuraAnio,
    resultadoMes, resultadoAnio, margenNetoMes,
    margenNetoAnio: pct(resultadoAnio, totalIngresosAnio)
  };
}

/* ---------------------------- FLUJO DE CAJA ---------------------------- */
function calcFlujoCaja(state, anio) {
  const saldoInicialTotal = sum(state.cuentas.map(c => c.saldoInicial));
  const entradas = addArr(diarioSumPorTipoMes(state, "INGRESO", anio), ganadoSumPorTipoMes(state, "SALIDA", "salida", anio));
  const salidas = addArr(diarioSumPorTipoMes(state, "EGRESO", anio), ganadoSumPorTipoMes(state, "ENTRADA", "entrada", anio));
  const flujoNeto = entradas.map((v, i) => v - salidas[i]);

  const saldoFinalAcumulado = [];
  let acc = saldoInicialTotal;
  for (let i = 0; i < 12; i++) { acc += flujoNeto[i]; saldoFinalAcumulado.push(acc); }

  const porCuenta = state.cuentas.map(c => {
    let ingresosAnio = 0, egresosAnio = 0;
    state.diario.forEach(r => {
      const { y } = monthYear(r.fecha);
      if (y !== anio || r.cuenta !== c.nombre) return;
      if (r.tipo === "INGRESO") ingresosAnio += Number(r.monto) || 0;
      else if (r.tipo === "EGRESO") egresosAnio += Number(r.monto) || 0;
    });
    state.ganadoMovimiento.forEach(r => {
      const { y } = monthYear(r.fecha);
      if (y !== anio || r.cuenta !== c.nombre) return;
      if (r.tipo === "SALIDA") ingresosAnio += montoTotalGanadoRow(r);
      if (r.tipo === "ENTRADA") egresosAnio += montoTotalGanadoRow(r);
    });
    const saldoFinal = (Number(c.saldoInicial) || 0) + ingresosAnio - egresosAnio;
    return { ...c, ingresosAnio, egresosAnio, saldoFinal };
  });

  return {
    anio, saldoInicialTotal, entradas, salidas, flujoNeto, saldoFinalAcumulado,
    totalEntradasAnio: sumArr(entradas), totalSalidasAnio: sumArr(salidas),
    saldoFinalAnio: saldoFinalAcumulado[11], porCuenta,
    totalPorCuentaFinal: sum(porCuenta.map(c => c.saldoFinal))
  };
}

/* ---------------------------- BALANCE GENERAL ---------------------------- */
function calcBalance(state, anio) {
  const flujo = calcFlujoCaja(state, anio);
  const inv = calcGanadoInventario(state);
  const activos = calcActivosFijos(state);
  const er = calcEstadoResultado(state, anio);

  const cuentaByName = n => flujo.porCuenta.find(c => c.nombre === n) || { saldoFinal: 0 };
  const caja = cuentaByName("Caja / Efectivo").saldoFinal;
  const banco = cuentaByName("Banco").saldoFinal;
  const tarjetaSaldo = cuentaByName("Tarjeta / Otros").saldoFinal;
  const tarjetaActivo = Math.max(0, tarjetaSaldo);
  const tarjetaPasivo = Math.max(0, -tarjetaSaldo);

  // Ganado como activo (NIC 41 — activos biológicos): la hacienda de venta/engorde (bien de
  // cambio) es activo CORRIENTE; la hacienda reproductora (cría) es activo NO corriente,
  // como un bien de uso — no se vende en el ciclo normal del negocio. `calcGanadoInventario`
  // ya separa el valor del rodeo en `totalValorActualVenta`/`totalValorActualCria` según la
  // `funcion` de cada categoría (Configuración → Categorías de Ganado).
  const totalActivoCorriente = caja + banco + tarjetaActivo + inv.totalValorActualVenta;

  const af = a => (activos.filas.find(f => f.concepto === a) || { valor: 0 }).valor;
  const tierra = af("Tierra / Campo (propio)");
  const instalaciones = af("Instalaciones (galpones, corrales)");
  const maquinaria = af("Maquinaria y Vehículos");
  const otrosAF = af("Otros activos fijos");
  const deprecAcumulada = activos.totalDeprecAnual; // simplificado: depreciación del año en curso
  const totalActivoNoCorriente = tierra + instalaciones + maquinaria + otrosAF - deprecAcumulada + inv.totalValorActualCria;

  const totalActivos = totalActivoCorriente + totalActivoNoCorriente;

  const pagoPrestamoAnio = sum(state.diario.filter(r => {
    const { y } = monthYear(r.fecha);
    return y === anio && r.categoria === "Pago de Préstamo";
  }).map(r => r.monto));
  const prestamoBancario = Math.max(0, (Number(state.pasivosIniciales.prestamoBancario) || 0) - pagoPrestamoAnio);
  const cuentaProveedores = Number(state.pasivosIniciales.cuentaProveedores) || 0;
  const otrosPasivos = Number(state.pasivosIniciales.otrosPasivos) || 0;
  const totalPasivos = prestamoBancario + cuentaProveedores + tarjetaPasivo + otrosPasivos;

  const caja0 = (state.cuentas.find(c => c.nombre === "Caja / Efectivo") || {}).saldoInicial || 0;
  const banco0 = (state.cuentas.find(c => c.nombre === "Banco") || {}).saldoInicial || 0;
  const tarjeta0 = (state.cuentas.find(c => c.nombre === "Tarjeta / Otros") || {}).saldoInicial || 0;
  const totalPasivosIniciales = (Number(state.pasivosIniciales.prestamoBancario)||0) + (Number(state.pasivosIniciales.cuentaProveedores)||0) + (Number(state.pasivosIniciales.otrosPasivos)||0) + Math.max(0, -tarjeta0);
  // Nota: el capital inicial se calcula con el TOTAL de activos fijos (tierra+instalaciones+maquinaria+otros),
  // no solo la tierra — así cuadra con el total de activos no corrientes del balance.
  const capitalInicial = caja0 + banco0 + Math.max(0, tarjeta0) + activos.totalValor + inv.totalValorInicial - totalPasivosIniciales;

  const aportesPeriodo = sum(state.diario.filter(r => {
    const { y } = monthYear(r.fecha);
    return y === anio && r.categoria === "Aporte de Capital / Préstamo" && r.tipo === "INGRESO";
  }).map(r => r.monto));

  const resultadoEjercicio = er.resultadoAnio;
  const totalPatrimonio = capitalInicial + aportesPeriodo + resultadoEjercicio;

  const controlCuadre = totalActivos - (totalPasivos + totalPatrimonio);

  return {
    anio, caja, banco, tarjetaActivo, tarjetaPasivo,
    inventarioGanado: inv.totalValorActual, // total combinado (compat), no usar para sumar el balance
    inventarioGanadoVenta: inv.totalValorActualVenta, inventarioGanadoCria: inv.totalValorActualCria,
    totalActivoCorriente, tierra, instalaciones, maquinaria, otrosAF, deprecAcumulada,
    totalActivoNoCorriente, totalActivos,
    prestamoBancario, cuentaProveedores, otrosPasivos, totalPasivos,
    capitalInicial, aportesPeriodo, resultadoEjercicio, totalPatrimonio,
    controlCuadre
  };
}

/* ---------------------------- ANÁLISIS / RATIOS ---------------------------- */
function calcAnalisis(state, anio) {
  const er = calcEstadoResultado(state, anio);
  const bal = calcBalance(state, anio);
  const inv = calcGanadoInventario(state);

  const ingresosTotales = er.totalIngresosAnio;
  const costosTotales = er.totalCostosDirectosAnio + er.totalEstructuraAnio;
  const resultado = er.resultadoAnio;

  const roa = pct(resultado, bal.totalActivos);
  const roe = pct(resultado, bal.totalPatrimonio);
  const puntoEquilibrio = er.margenBrutoAnio !== 0 ? er.totalEstructuraAnio / (er.margenBrutoAnio / (er.totalIngresosAnio || 1)) : 0;

  const rubros = [
    { nombre: "Compra de Ganado", importe: sumArr(er.compraGanado) },
    ...er.costosDirectosDetalle.map(c => ({ nombre: c.nombre, importe: sumArr(c.valores) })),
    ...er.estructuraDetalle.map(c => ({ nombre: c.nombre, importe: sumArr(c.valores) })),
    { nombre: "Depreciación", importe: sumArr(er.depreciacionMes) }
  ].map(r => ({ ...r, pctTotal: pct(r.importe, costosTotales) }))
   .sort((a, b) => b.importe - a.importe);

  const stockActual = inv.totalStockActual;
  const compradas = inv.totalEntradas;
  const nacimientos = inv.totalNacimientos;
  const vendidas = inv.totalSalidas;
  const muertes = inv.totalMuertes;
  const disponibles = inv.totalStockInicial + compradas + nacimientos;
  const tasaMortalidad = pct(muertes, disponibles);
  const tasaExtraccion = pct(vendidas, disponibles);
  const costoPorCabeza = pct(costosTotales, (inv.totalStockInicial + stockActual) / 2);

  const totalKgComprado = sum(state.ganadoMovimiento.filter(m => monthYear(m.fecha).y === anio && m.tipo === "ENTRADA").map(m => m.kgEntrada));
  const totalBsComprado = sumArr(er.compraGanado);
  const totalBsVendido = sumArr(er.ventaGanado);

  // Nota: el precio promedio de venta por kg NO se puede mezclar entre tipos de venta
  // (kilo vivo, kilo gancho y al bulto son bases distintas — igual que el bug ya corregido
  // en Almacén de no sumar stock de productos con distinta unidad). Por eso se calculan
  // por separado, y "Al Bulto" no tiene un Bs/kg (se informa solo el monto total vendido así).
  const ventasAnio = state.ganadoMovimiento.filter(m => monthYear(m.fecha).y === anio && m.tipo === "SALIDA");
  const ventasKiloVivo = ventasAnio.filter(m => (m.tipoVenta || "Kilo Vivo") === "Kilo Vivo");
  const ventasKiloGancho = ventasAnio.filter(m => m.tipoVenta === "Kilo Gancho");
  const ventasAlBulto = ventasAnio.filter(m => m.tipoVenta === "Al Bulto");
  const totalKgVendidoVivo = sum(ventasKiloVivo.map(m => m.kgSalida));
  const totalBsVendidoVivo = sum(ventasKiloVivo.map(montoTotalGanadoRow));
  const totalKgVendidoGancho = sum(ventasKiloGancho.map(m => m.kgGanchoSalida));
  const totalBsVendidoGancho = sum(ventasKiloGancho.map(montoTotalGanadoRow));
  const totalBsVendidoBulto = sum(ventasAlBulto.map(montoTotalGanadoRow));
  const totalCabezasBulto = sum(ventasAlBulto.map(m => m.cabezas));

  return {
    anio, ingresosTotales, costosTotales, resultado,
    estado: resultado > 0 ? "RENTABLE" : (resultado === 0 ? "EQUILIBRIO" : "PÉRDIDA"),
    margenBrutoPct: pct(er.margenBrutoAnio, ingresosTotales),
    margenNetoPct: er.margenNetoAnio,
    roa, roe, puntoEquilibrio, rubros,
    mayorCosto: rubros[0] || null,
    stockActual, compradas, nacimientos, vendidas, muertes,
    tasaMortalidad, tasaExtraccion, costoPorCabeza,
    margenBrutoGanadero: totalBsVendido - totalBsComprado,
    valorActualRodeo: inv.totalValorActual,
    precioPromVentaKiloVivo: pct(totalBsVendidoVivo, totalKgVendidoVivo),
    precioPromVentaKiloGancho: pct(totalBsVendidoGancho, totalKgVendidoGancho),
    totalBsVendidoBulto, totalCabezasBulto,
    precioPromCompra: pct(totalBsComprado, totalKgComprado),
    cargaAnimalEVporHa: inv.cargaAnimalEVporHa,
    totalEV: inv.totalEV
  };
}

/* ---------------------------- DASHBOARD / INICIO ---------------------------- */
function calcDashboard(state) {
  const anio = state.meta.anio;
  const an = calcAnalisis(state, anio);
  const flujo = calcFlujoCaja(state, anio);
  const inv = calcGanadoInventario(state);
  const alertas = [];

  if (flujo.saldoFinalAnio < (Number(state.meta.alertaCajaMin) || 0)) {
    alertas.push({ level: "warn", text: "⚠️ Caja baja — revisá gastos" });
  } else {
    alertas.push({ level: "ok", text: "✅ Caja OK" });
  }
  if (an.resultado < 0) alertas.push({ level: "bad", text: "⚠️ Estás perdiendo plata" });
  else if (an.resultado === 0) alertas.push({ level: "warn", text: "➖ Sin datos aún" });
  else alertas.push({ level: "ok", text: "✅ Vas rentable" });

  if (an.tasaMortalidad > 0.03) alertas.push({ level: "warn", text: "⚠️ Mortalidad alta (>3%)" });
  else alertas.push({ level: "ok", text: "✅ Mortalidad normal" });

  const stockNegativo = inv.filas.some(f => f.stockActual < 0);
  if (stockNegativo) alertas.push({ level: "bad", text: "⚠️ Hay stock negativo — revisá movimientos" });
  else alertas.push({ level: "ok", text: "✅ Stock OK" });

  return {
    anio,
    resultado: an.resultado,
    estado: an.estado,
    caja: flujo.saldoFinalAnio,
    valorRodeo: inv.totalValorActual,
    cabezasTotales: inv.totalStockActual,
    cargaAnimal: inv.cargaAnimalEVporHa,
    margenNeto: an.margenNetoPct,
    alertas
  };
}
