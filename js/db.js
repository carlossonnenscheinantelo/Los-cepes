/* ==========================================================================
   db.js — modelo de datos, persistencia (localStorage) e import/export Excel
   ========================================================================== */

const STORAGE_KEY = "estanciaDB_v1";
const IMAGE_KEY   = "estanciaDB_v1_imgs"; // imágenes de comprobantes en clave separada

/* ---------- helpers de imagen separada ---------- */
function loadImages() {
  try { const r = localStorage.getItem(IMAGE_KEY); return r ? JSON.parse(r) : {}; }
  catch(e) { return {}; }
}

function saveImages(map) {
  // Si no cabe, intenta liberar espacio borrando las imágenes más pesadas
  const tryStore = m => localStorage.setItem(IMAGE_KEY, JSON.stringify(m));
  try { tryStore(map); return; } catch(e) { /* lleno */ }
  const pairs = Object.entries(map).sort((a,b) => b[1].length - a[1].length);
  for (let i = 0; i < pairs.length; i++) {
    delete map[pairs[i][0]];
    try { tryStore(map); return; } catch(e) { /* sigue lleno */ }
  }
  console.warn("No se pudieron guardar imágenes de comprobantes.");
}

// Extrae data-URLs del clon del state y las reemplaza con '__img__'; devuelve el mapa {id: dataUrl}
// Cada fila puede tener HASTA DOS fotos: `comprobante` (comprobante de pago — QR,
// transferencia, depósito) y `facturaCompra` (factura/recibo de compra, distinto del
// pago, usado para reconocer el producto). Se guardan bajo dos claves separadas en el
// mismo mapa: `id` para el comprobante de pago, `id + "_factura"` para la factura.
function extractComprobantes(stateClone) {
  const imgs = {};
  const cols = ["diario", "almacenMovimientos", "ganadoMovimiento", "personalMovimientos"];
  cols.forEach(col => {
    (stateClone[col] || []).forEach(r => {
      if (r.comprobante && String(r.comprobante).startsWith("data:")) {
        imgs[r.id] = r.comprobante;
        r.comprobante = "__img__";
      }
      if (r.facturaCompra && String(r.facturaCompra).startsWith("data:")) {
        imgs[r.id + "_factura"] = r.facturaCompra;
        r.facturaCompra = "__img__";
      }
    });
  });
  return imgs;
}

// Inyecta imágenes de vuelta en el state en memoria
function injectComprobantes(state, imgs) {
  const cols = ["diario", "almacenMovimientos", "ganadoMovimiento", "personalMovimientos"];
  cols.forEach(col => {
    (state[col] || []).forEach(r => {
      if (r.comprobante === "__img__" && imgs[r.id]) r.comprobante = imgs[r.id];
      if (r.facturaCompra === "__img__" && imgs[r.id + "_factura"]) r.facturaCompra = imgs[r.id + "_factura"];
    });
  });
}

// Borra imágenes huérfanas (de filas ya eliminadas)
function purgeOrphanImages() {
  const imgs = loadImages();
  const validIds = new Set();
  ["diario","almacenMovimientos","ganadoMovimiento","personalMovimientos"].forEach(col => {
    (STATE[col] || []).forEach(r => {
      if (r.comprobante) validIds.add(r.id);
      if (r.facturaCompra) validIds.add(r.id + "_factura");
    });
  });
  let n = 0;
  Object.keys(imgs).forEach(id => { if (!validIds.has(id)) { delete imgs[id]; n++; } });
  if (n > 0) saveImages(imgs);
  return n;
}

// Devuelve cuántos KB ocupa el almacenamiento (main + images)
function storageUsageKB() {
  const main = (localStorage.getItem(STORAGE_KEY) || "").length;
  const imgs = (localStorage.getItem(IMAGE_KEY) || "").length;
  return { mainKB: Math.round(main / 1024), imgsKB: Math.round(imgs / 1024), totalKB: Math.round((main + imgs) / 1024) };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  const anio = new Date().getFullYear();
  return {
    version: 1,
    meta: {
      anio: anio,
      alertaCajaMin: 0,
      aportePatronal: 0.1171,
      superficieHa: 0,
      nombreEstancia: "Estancia Los Cepes"
    },
    cuentas: [
      { id: uid(), nombre: "Caja / Efectivo", clasificacion: "Activo", saldoInicial: 0 },
      { id: uid(), nombre: "Banco", clasificacion: "Activo", saldoInicial: 0 },
      { id: uid(), nombre: "Tarjeta / Otros", clasificacion: "Pasivo", saldoInicial: 0 }
    ],
    activosFijos: [
      { id: uid(), concepto: "Tierra / Campo (propio)", valor: 0, vidaUtil: null },
      { id: uid(), concepto: "Instalaciones (galpones, corrales)", valor: 0, vidaUtil: 20 },
      { id: uid(), concepto: "Maquinaria y Vehículos", valor: 0, vidaUtil: 10 },
      { id: uid(), concepto: "Otros activos fijos", valor: 0, vidaUtil: 10 }
    ],
    pasivosIniciales: {
      prestamoBancario: 0,
      cuentaProveedores: 0,
      otrosPasivos: 0
    },
    categoriasDiario: [
      { id: uid(), nombre: "Sueldos y Salarios", tipo: "EGRESO", grupo: "Mano de Obra" },
      { id: uid(), nombre: "Adelanto a Personal", tipo: "EGRESO", grupo: "Mano de Obra" },
      { id: uid(), nombre: "Combustible", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Víveres / Alimentación", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Accesorios / Almacén", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Herramientas", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Sanidad Animal", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Suplementos / Nutrición", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Mantenimiento / Repuestos", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Flete / Transporte", tipo: "EGRESO", grupo: "Gastos Directos" },
      { id: uid(), nombre: "Gastos Fijos (arriendo/seguros/serv.)", tipo: "EGRESO", grupo: "Estructura" },
      { id: uid(), nombre: "Honorarios / Administración", tipo: "EGRESO", grupo: "Estructura" },
      { id: uid(), nombre: "Impuestos / Tasas", tipo: "EGRESO", grupo: "Estructura" },
      { id: uid(), nombre: "Otros Egresos", tipo: "EGRESO", grupo: "Estructura" },
      { id: uid(), nombre: "Compra de Activos (inversión)", tipo: "EGRESO", grupo: "Inversión" },
      { id: uid(), nombre: "Pago de Préstamo", tipo: "EGRESO", grupo: "Financiación" },
      { id: uid(), nombre: "Venta de Ganado", tipo: "INGRESO", grupo: "Ingreso Operativo" },
      { id: uid(), nombre: "Venta de Subproductos", tipo: "INGRESO", grupo: "Ingreso Operativo" },
      { id: uid(), nombre: "Otros Ingresos", tipo: "INGRESO", grupo: "Ingreso Operativo" },
      { id: uid(), nombre: "Aporte de Capital / Préstamo", tipo: "INGRESO", grupo: "Financiación" }
    ],
    categoriasGanado: [
      // "funcion" clasifica el activo para el Balance (ver NIC 41): la hacienda reproductora
      // (Toro/Vaca de cría) se lleva como activo NO corriente; el resto (recría/engorde,
      // destinado a la venta) se lleva como bien de cambio, activo corriente. Es editable
      // por categoría en Configuración por si el manejo real del campo es distinto.
      { id: uid(), nombre: "Toro", coefEV: 1.2, funcion: "Cría (reproductor)" },
      { id: uid(), nombre: "Vaca", coefEV: 1.0, funcion: "Cría (reproductor)" },
      { id: uid(), nombre: "Vaquillona +2 años", coefEV: 0.9, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Vaquillona 1-2 años", coefEV: 0.7, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Novillo +3 años", coefEV: 1.2, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Torillo 2-3 años", coefEV: 1.1, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Torillo 1-2 años", coefEV: 0.85, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Ternero (destete)", coefEV: 0.6, funcion: "Venta (engorde)" },
      { id: uid(), nombre: "Ternera (destete)", coefEV: 0.55, funcion: "Venta (engorde)" }
    ],
    empleados: [
      { id: uid(), cargo: "Administrador / Gerente", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Capataz", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Vaquero / Peón 1", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Vaquero / Peón 2", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Vaquero / Peón 3", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Vaquero / Peón 4", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Cocinera", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Tractorista / Mecánico", cantidad: 1, haberBasico: 0, bonoProd: 0 },
      { id: uid(), cargo: "Guardia / Cuidador", cantidad: 1, haberBasico: 0, bonoProd: 0 }
    ],
    gastosFijos: [
      { id: uid(), concepto: "Arrendamiento / Alquiler del Campo", importeMensual: 0, observaciones: "Ajustar según contrato" },
      { id: uid(), concepto: "Seguro Ganadero", importeMensual: 0, observaciones: "Animales y producción" },
      { id: uid(), concepto: "Seguro Inmuebles / Instalaciones", importeMensual: 0, observaciones: "Galpones, corrales, vivienda" },
      { id: uid(), concepto: "Energía Eléctrica", importeMensual: 0, observaciones: "Generador + red" },
      { id: uid(), concepto: "Agua (mantenimiento pozos/bombas)", importeMensual: 0, observaciones: "" },
      { id: uid(), concepto: "Internet / Comunicaciones", importeMensual: 0, observaciones: "Satelital o celular" },
      { id: uid(), concepto: "Honorarios Contador / Asesor", importeMensual: 0, observaciones: "Mensual fijo" },
      { id: uid(), concepto: "Cuota Maquinaria / Préstamos Bancarios", importeMensual: 0, observaciones: "Ajustar a cuota real" },
      { id: uid(), concepto: "Mantenimiento Corrales y Alambrados", importeMensual: 0, observaciones: "Promedio mensual" },
      { id: uid(), concepto: "Mantenimiento Sistema de Agua", importeMensual: 0, observaciones: "Bombas, tuberías" },
      { id: uid(), concepto: "Otros Gastos Fijos", importeMensual: 0, observaciones: "Misceláneos" }
    ],
    gastosVariables: [
      { id: uid(), seccion: "COMBUSTIBLE", concepto: "Diésel (tractor/generador)", unidad: "litros", cantidadMes: 0, precioUnit: 6.5, observaciones: "Consumo promedio mensual" },
      { id: uid(), seccion: "COMBUSTIBLE", concepto: "Gasolina (vehículos campo)", unidad: "litros", cantidadMes: 0, precioUnit: 6.7, observaciones: "Camioneta, motos" },
      { id: uid(), seccion: "COMBUSTIBLE", concepto: "Aceites y lubricantes", unidad: "unidad", cantidadMes: 0, precioUnit: 180, observaciones: "" },
      { id: uid(), seccion: "VÍVERES Y ALIMENTACIÓN", concepto: "Alimentos (raciones personal)", unidad: "persona/mes", cantidadMes: 0, precioUnit: 800, observaciones: "10 pers × ración completa" },
      { id: uid(), seccion: "VÍVERES Y ALIMENTACIÓN", concepto: "Bebidas e insumos cocina", unidad: "global", cantidadMes: 0, precioUnit: 500, observaciones: "Azúcar, aceite, condimentos" },
      { id: uid(), seccion: "VÍVERES Y ALIMENTACIÓN", concepto: "Agua potable (bidones 20L)", unidad: "bidón", cantidadMes: 0, precioUnit: 15, observaciones: "" },
      { id: uid(), seccion: "SANIDAD ANIMAL", concepto: "Vacunas (aftosa, brucelosis…)", unidad: "dosis", cantidadMes: 0, precioUnit: 12, observaciones: "Calendario sanitario anual" },
      { id: uid(), seccion: "SANIDAD ANIMAL", concepto: "Antiparasitarios / garrapaticida", unidad: "litro", cantidadMes: 0, precioUnit: 350, observaciones: "" },
      { id: uid(), seccion: "SANIDAD ANIMAL", concepto: "Antibióticos y medicamentos", unidad: "global", cantidadMes: 0, precioUnit: 800, observaciones: "Stock botiquín campo" },
      { id: uid(), seccion: "SANIDAD ANIMAL", concepto: "Honorarios veterinario", unidad: "visita", cantidadMes: 0, precioUnit: 600, observaciones: "" },
      { id: uid(), seccion: "SUPLEMENTOS Y NUTRICIÓN", concepto: "Sales minerales", unidad: "bolsa 25kg", cantidadMes: 0, precioUnit: 120, observaciones: "" },
      { id: uid(), seccion: "SUPLEMENTOS Y NUTRICIÓN", concepto: "Suplemento proteico / bloque", unidad: "unidad", cantidadMes: 0, precioUnit: 80, observaciones: "" },
      { id: uid(), seccion: "SUPLEMENTOS Y NUTRICIÓN", concepto: "Melaza / energético", unidad: "litros", cantidadMes: 0, precioUnit: 4.5, observaciones: "" },
      { id: uid(), seccion: "MANTENIMIENTO Y REPUESTOS", concepto: "Repuestos tractor / vehículos", unidad: "global", cantidadMes: 0, precioUnit: 800, observaciones: "Promedio mensual" },
      { id: uid(), seccion: "MANTENIMIENTO Y REPUESTOS", concepto: "Herramientas y materiales campo", unidad: "global", cantidadMes: 0, precioUnit: 400, observaciones: "Alambres, postes, etc." },
      { id: uid(), seccion: "OTROS VARIABLES", concepto: "Flete / transporte ganado", unidad: "viaje", cantidadMes: 0, precioUnit: 1500, observaciones: "Ocasional" },
      { id: uid(), seccion: "OTROS VARIABLES", concepto: "Gastos veterinarios emergencia", unidad: "global", cantidadMes: 0, precioUnit: 500, observaciones: "" },
      { id: uid(), seccion: "OTROS VARIABLES", concepto: "Comunicaciones / celulares", unidad: "global", cantidadMes: 0, precioUnit: 300, observaciones: "" },
      { id: uid(), seccion: "OTROS VARIABLES", concepto: "Papelería y oficina", unidad: "global", cantidadMes: 0, precioUnit: 150, observaciones: "" },
      { id: uid(), seccion: "OTROS VARIABLES", concepto: "Imprevistos varios", unidad: "global", cantidadMes: 0, precioUnit: 500, observaciones: "~5% gastos totales" }
    ],
    diario: [],
    ganadoMovimiento: [],
    personalMovimientos: [],
    inventarioCrea: {
      fecha: "",
      superficieHa: 0
      // stock inicial y precios por categoría viven en inventarioCreaCategorias
    },
    inventarioCreaCategorias: [], // { categoriaId, cabezas, pesoProm, precioBsCab } — se auto-siembra desde categoriasGanado
    // Subcategorías/productos aprendidos automáticamente al cargar el Diario (por categoría).
    // Se van agregando solas a medida que el usuario carga compras — no hace falta configurarlas a mano.
    subcategoriasDiario: {
      "Víveres / Alimentación": ["Alimentos (raciones personal)", "Bebidas e insumos cocina", "Agua potable (bidones 20L)"]
    },
    animales: [], // inventario individual: { id, numero (arete), marcaOrigen (marca de origen de compra, para trazabilidad — la marca actual de todo el rodeo es la de Los Cepes), categoria, colorArete, sexo, pesoKg, fechaNacimiento, fechaIngreso, potrero, madre, estado, observaciones } — se arma importando una planilla Excel
    // Almacén: catálogo de productos (Víveres, Accesorios, Sanidad, Nutrición) + su stock,
    // y el detalle de movimientos (compras que suman stock, consumos que restan stock).
    almacenProductos: [], // { id, nombre, categoria: "Víveres"|"Accesorios"|"Sanidad"|"Nutrición"|"Combustible", unidad, precioVentaTrabajador (precio de venta POR DEFECTO, usado si un lote no tiene el suyo propio), stock (calculado) }
    almacenMovimientos: [], // { id, fecha, productoId, tipo: "compra"|"consumo_trabajador"|"consumo"|"ajuste", cantidad, precioUnitario, precioVentaLote (solo en "compra": precio de venta al trabajador de ESE lote), total, empleadoId, personalMovId, diarioId, trabajoSanitarioId, observacion, comprobante }
    almacenConteos: [], // historial de controles de inventario físico: { id, fecha, detalle: [{productoId, nombre, stockSistema, stockContado, diferencia}] }
    // Tipos de trabajo sanitario configurables (Vacunación, Desparasitación, Mineralización, Areteado…
    // el usuario puede agregar más tipos propios desde la pantalla de Trabajos Sanitarios).
    tiposTrabajoSanitario: [
      { id: uid(), nombre: "Vacunación" },
      { id: uid(), nombre: "Desparasitación" },
      { id: uid(), nombre: "Mineralización" },
      { id: uid(), nombre: "Areteado" }
    ],
    // Trabajos sanitarios aplicados a una categoría/tropa de ganado (cabecera del evento).
    // Los productos de Sanidad/Nutrición realmente usados se guardan como almacenMovimientos
    // de tipo "consumo" con trabajoSanitarioId apuntando acá (así se descuentan solos del stock).
    trabajosSanitarios: [] // { id, fecha, categoriaGanadoId, cabezas, tipoTrabajoId, observaciones }
  };
}

function migrateState(state) {
  // Asegura que existan todas las claves nuevas si el usuario tenía un estado viejo guardado
  const def = defaultState();
  for (const k of Object.keys(def)) {
    if (!(k in state)) state[k] = def[k];
  }
  if (!state.meta) state.meta = def.meta;
  for (const k of Object.keys(def.meta)) {
    if (!(k in state.meta)) state.meta[k] = def.meta[k];
  }
  // Si el usuario nunca renombró la estancia (seguía con el nombre genérico viejo), se actualiza
  // solo al nuevo default "Estancia Los Cepes" — si ya lo había personalizado a otra cosa, no se toca.
  if (!state.meta.nombreEstancia || state.meta.nombreEstancia === "Mi Estancia") {
    state.meta.nombreEstancia = "Estancia Los Cepes";
  }
  // sembrar inventarioCreaCategorias si falta alguna categoría
  state.categoriasGanado.forEach(cat => {
    if (!state.inventarioCreaCategorias.find(r => r.categoriaId === cat.id)) {
      state.inventarioCreaCategorias.push({ categoriaId: cat.id, cabezas: 0, pesoProm: 0, precioBsCab: 0 });
    }
  });
  // Backfill de "función" (Cría/Venta) para estados guardados de antes de que existiera este
  // campo — clasifica el ganado como activo no corriente (reproductor) o bien de cambio
  // corriente (engorde/venta) en el Balance (NIC 41). Toro/Vaca quedan como "Cría" por default
  // (son las categorías reproductoras típicas); el resto como "Venta" — el usuario puede
  // corregirlo por categoría en Configuración si su manejo real es distinto.
  state.categoriasGanado.forEach(cat => {
    if (!cat.funcion) {
      const n = (cat.nombre || "").trim().toLowerCase();
      cat.funcion = (n === "toro" || n === "vaca") ? "Cría (reproductor)" : "Venta (engorde)";
    }
  });
  // agregar la categoría "Adelanto a Personal" si el usuario ya tenía un estado guardado sin ella
  if (!state.categoriasDiario.find(c => c.nombre.trim().toLowerCase() === "adelanto a personal")) {
    state.categoriasDiario.push({ id: uid(), nombre: "Adelanto a Personal", tipo: "EGRESO", grupo: "Mano de Obra" });
  }
  // agregar la categoría "Accesorios / Almacén" si el usuario ya tenía un estado guardado sin ella
  if (!state.categoriasDiario.find(c => c.nombre.trim().toLowerCase() === "accesorios / almacén")) {
    state.categoriasDiario.push({ id: uid(), nombre: "Accesorios / Almacén", tipo: "EGRESO", grupo: "Gastos Directos" });
  }
  // agregar la categoría "Herramientas" si el usuario ya tenía un estado guardado sin ella
  if (!state.categoriasDiario.find(c => c.nombre.trim().toLowerCase() === "herramientas")) {
    state.categoriasDiario.push({ id: uid(), nombre: "Herramientas", tipo: "EGRESO", grupo: "Gastos Directos" });
  }
  // Trabajos Sanitarios: sembrar los tipos por defecto si el usuario ya tenía un estado
  // guardado de antes de que existiera esta función (migrateState ya copia la clave completa
  // si faltaba, pero si faltaban solo ALGUNOS tipos default se completan acá).
  ["Vacunación", "Desparasitación", "Mineralización", "Areteado"].forEach(nombre => {
    if (!state.tiposTrabajoSanitario.find(t => t.nombre.trim().toLowerCase() === nombre.toLowerCase())) {
      state.tiposTrabajoSanitario.push({ id: uid(), nombre });
    }
  });
  // Almacén: si ya había compras cargadas en el Diario (Víveres/Accesorios/Herramientas/Sanidad/Nutrición/Combustible)
  // antes de que existiera este módulo, se crea solo el producto en el catálogo (sin inventar cantidades:
  // el stock de esas compras viejas queda en 0 hasta que se sepa la cantidad real).
  backfillAlmacenProductosEnEstado(state);
  // Si una fila del Diario ya tiene un movimiento de almacén vinculado (de una compra cargada
  // en una iteración anterior) pero todavía no tiene sus propios campos cantidad/unidad/precioUnitario,
  // se los copia para que se puedan ver y editar directamente desde el Diario.
  backfillDiarioCantidadesDesdeAlmacen(state);
  return state;
}

let STATE = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      STATE = migrateState(JSON.parse(raw));
      // Reinyectar imágenes guardadas en la clave separada
      injectComprobantes(STATE, loadImages());
    } else {
      STATE = migrateState(defaultState());
    }
  } catch (e) {
    console.error("Error cargando estado, se reinicia:", e);
    STATE = migrateState(defaultState());
  }
  return STATE;
}

let saveTimeout = null;
function saveState() {
  const indicator = document.getElementById("saveIndicator");
  if (indicator) { indicator.textContent = "Guardando…"; indicator.classList.add("saving"); }
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      // 1. Clonar el state y extraer las imágenes de comprobantes a un mapa separado
      const stateClone = JSON.parse(JSON.stringify(STATE));
      const newImgs = extractComprobantes(stateClone); // reemplaza data-URLs por '__img__' en el clon

      // 2. Construir mapa de imágenes: existentes vigentes + nuevas
      // (cada fila puede tener dos claves: `id` para el comprobante de pago
      // y `id + "_factura"` para la factura/recibo de compra — ver extractComprobantes)
      const existing = loadImages();
      const allIds = new Set();
      ["diario","almacenMovimientos","ganadoMovimiento","personalMovimientos"].forEach(col => {
        (STATE[col] || []).forEach(r => { allIds.add(r.id); allIds.add(r.id + "_factura"); });
      });
      const mergedImgs = {};
      Object.entries(existing).forEach(([id, img]) => { if (allIds.has(id)) mergedImgs[id] = img; });
      Object.assign(mergedImgs, newImgs);

      // 3. Guardar imágenes en su clave separada (si no cabe, libera automáticamente)
      saveImages(mergedImgs);

      // 4. Guardar state principal SIN imágenes — siempre cabe
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateClone));
      if (indicator) { indicator.textContent = "Guardado ✓"; indicator.classList.remove("saving"); }
    } catch (e) {
      console.error("No se pudo guardar:", e);
      if (indicator) { indicator.textContent = "⚠️ No se pudo guardar"; indicator.classList.remove("saving"); }
      alert("Error inesperado al guardar. Por favor exportá una copia de seguridad (.json) desde Datos antes de continuar.");
    }
  }, 150);
}

function resetState() {
  if (!confirm("¿Seguro? Esto borra TODOS los datos cargados en esta app (no afecta tus archivos Excel).")) return;
  localStorage.removeItem(STORAGE_KEY);
  STATE = defaultState();
  saveState();
  location.hash = "#/inicio";
  location.reload();
}

/* ---------------------------- CRUD genérico ---------------------------- */
function crudAdd(collectionName, obj) {
  obj.id = uid();
  STATE[collectionName].push(obj);
  if (collectionName === "diario") { learnSubcategoria(obj.categoria, obj.subcategoria); syncAlmacenMovimientoDesdeDiario(obj); }
  if (collectionName === "animales") syncInventarioCreaDesdeAnimales();
  if (collectionName === "almacenMovimientos" || collectionName === "almacenProductos") recalcStockAlmacen();
  if (collectionName === "ganadoMovimiento") syncFleteDiarioDesdeGanado(obj);
  saveState();
  return obj;
}
function crudUpdate(collectionName, id, patch) {
  const row = STATE[collectionName].find(r => r.id === id);
  if (row) {
    Object.assign(row, patch);
    if (collectionName === "diario") { learnSubcategoria(row.categoria, row.subcategoria); syncAlmacenMovimientoDesdeDiario(row); }
    if (collectionName === "ganadoMovimiento") syncFleteDiarioDesdeGanado(row);
  }
  if (collectionName === "animales") syncInventarioCreaDesdeAnimales();
  if (collectionName === "almacenMovimientos" || collectionName === "almacenProductos") recalcStockAlmacen();
  saveState();
  return row;
}
function crudDelete(collectionName, id) {
  STATE[collectionName] = STATE[collectionName].filter(r => r.id !== id);
  // Si se borra un adelanto/consumo de un trabajador que tenía un producto de almacén
  // vinculado, hay que borrar también ese movimiento de almacén (si no, el stock queda mal).
  if (collectionName === "personalMovimientos") {
    const antes = STATE.almacenMovimientos.length;
    STATE.almacenMovimientos = STATE.almacenMovimientos.filter(m => m.personalMovId !== id);
    if (STATE.almacenMovimientos.length !== antes) recalcStockAlmacen();
  }
  // Si se borra una compra del Diario que había generado stock en Almacén,
  // hay que borrar también ese movimiento de almacén (si no, el stock queda mal).
  if (collectionName === "diario") {
    const antes = STATE.almacenMovimientos.length;
    STATE.almacenMovimientos = STATE.almacenMovimientos.filter(m => m.diarioId !== id);
    if (STATE.almacenMovimientos.length !== antes) recalcStockAlmacen();
  }
  // Si se borra una venta de Ganado que había generado un gasto espejo de Flete en el Diario,
  // hay que borrar también esa fila del Diario (si no, queda un gasto de flete huérfano).
  // Si se borra una ENTRADA que era la compra inicial vinculada a una categoría del
  // Levantamiento (CREA), hay que soltar esa referencia (si no, "entradaMovId" queda
  // apuntando a un movimiento que ya no existe). Si se borra una ENTRADA que tenía animales
  // individuales numerados al comprarlos (`compraMovId`), NO se borran esos animales (son
  // registros reales) — solo se suelta la referencia, para no dejarla apuntando a un
  // movimiento inexistente (el costo de compra que ya tienen cargado se conserva igual).
  if (collectionName === "ganadoMovimiento") {
    STATE.diario = STATE.diario.filter(d => d.ganadoMovId !== id);
    STATE.inventarioCreaCategorias.forEach(r => { if (r.entradaMovId === id) r.entradaMovId = undefined; });
    STATE.animales.forEach(a => { if (a.compraMovId === id) a.compraMovId = undefined; });
  }
  if (collectionName === "animales") syncInventarioCreaDesdeAnimales();
  if (collectionName === "almacenMovimientos" || collectionName === "almacenProductos") recalcStockAlmacen();
  saveState();
}

/* ==========================================================================
   Subcategorías del Diario (autocompletado que se auto-alimenta)
   ========================================================================== */
function getSubcategorias(categoria) {
  if (!categoria) return allSubcategorias();
  return (STATE.subcategoriasDiario[categoria] || []).slice().sort((a, b) => a.localeCompare(b));
}
function allSubcategorias() {
  const set = new Set();
  Object.values(STATE.subcategoriasDiario || {}).forEach(arr => (arr || []).forEach(v => set.add(v)));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
function learnSubcategoria(categoria, valor) {
  if (!categoria || !valor) return;
  const v = String(valor).trim();
  if (!v) return;
  if (!STATE.subcategoriasDiario[categoria]) STATE.subcategoriasDiario[categoria] = [];
  const list = STATE.subcategoriasDiario[categoria];
  const exists = list.some(x => x.trim().toLowerCase() === v.toLowerCase());
  if (!exists) list.push(v);
}

/* ==========================================================================
   Ganado: tipos de venta y destinos (para movimientos de tipo SALIDA)
   ========================================================================== */
const TIPOS_VENTA_GANADO = ["Kilo Vivo", "Kilo Gancho", "Al Bulto"];
const DESTINOS_VENTA_GANADO = ["Frigorífico", "Feria / Remate", "Venta Particular", "Invernada / Otro campo", "Consumo interno", "Otro"];

/* ==========================================================================
   Almacén: catálogo de productos + stock (Víveres, Accesorios, Sanidad, Nutrición)
   ========================================================================== */
const ALMACEN_CATEGORIAS = ["Víveres", "Accesorios", "Herramientas", "Sanidad", "Nutrición", "Combustible"];
// A qué categoría del Diario va cada compra de almacén, según la categoría del producto.
const ALMACEN_CATEGORIA_A_DIARIO = {
  "Víveres": "Víveres / Alimentación",
  "Accesorios": "Accesorios / Almacén",
  "Herramientas": "Herramientas",
  "Sanidad": "Sanidad Animal",
  "Nutrición": "Suplementos / Nutrición",
  "Combustible": "Combustible"
};
// Mapeo inverso: si en el Diario elegís esta categoría, el gasto también alimenta el
// stock de almacén de esta categoría (usado para mostrar los campos Cantidad/Precio unitario).
const DIARIO_CATEGORIA_A_ALMACEN = Object.fromEntries(
  Object.entries(ALMACEN_CATEGORIA_A_DIARIO).map(([alm, diario]) => [diario, alm])
);

/**
 * Recalcula el stock de cada producto de almacén a partir de su historial de
 * movimientos: las "compras" suman, "consumo"/"consumo_trabajador" siempre restan
 * (su cantidad se guarda en positivo), y los "ajuste" (de un control de inventario
 * físico) suman o restan según su signo (+ sobrante, - faltante).
 * El stock nunca se edita a mano — siempre se deriva de los movimientos cargados.
 */
function recalcStockAlmacen() {
  STATE.almacenProductos.forEach(p => {
    const movs = STATE.almacenMovimientos.filter(m => m.productoId === p.id);
    let stock = 0;
    movs.forEach(m => {
      const cant = Number(m.cantidad) || 0;
      if (m.tipo === "compra" || m.tipo === "ajuste") stock += cant;
      else stock -= cant;
    });
    p.stock = Math.round(stock * 100) / 100;
  });
}

/**
 * Registra un control de inventario físico: recibe la fecha del conteo y una lista de
 * { productoId, stockContado } (uno por cada producto que efectivamente se contó — los
 * que no se cuentan esa vez simplemente no se incluyen y quedan como estaban). Por cada
 * producto con diferencia respecto al stock del sistema, crea un movimiento "ajuste" con
 * la diferencia (positiva = sobrante, negativa = faltante) y deja guardado el detalle
 * completo del conteo en `almacenConteos` para poder consultarlo después.
 */
function registrarConteoInventario(fecha, conteos) {
  const detalle = [];
  (conteos || []).forEach(c => {
    const producto = STATE.almacenProductos.find(p => p.id === c.productoId);
    if (!producto) return;
    const stockSistema = Number(producto.stock) || 0;
    const stockContado = Number(c.stockContado) || 0;
    const diferencia = Math.round((stockContado - stockSistema) * 100) / 100;
    detalle.push({ productoId: producto.id, nombre: producto.nombre, categoria: producto.categoria, unidad: producto.unidad, stockSistema, stockContado, diferencia });
    if (diferencia !== 0) {
      STATE.almacenMovimientos.push({
        id: uid(), fecha, productoId: producto.id, tipo: "ajuste",
        cantidad: diferencia, precioUnitario: producto.precioVentaTrabajador || 0, total: 0,
        observacion: `Ajuste por conteo físico del ${fecha} (${diferencia > 0 ? "sobrante" : "faltante"})`
      });
    }
  });
  recalcStockAlmacen();
  STATE.almacenConteos.push({ id: uid(), fecha, detalle });
  saveState();
  return detalle;
}

function findOrCreateProductoAlmacen(nombre, categoria, unidad) {
  const n = String(nombre || "").trim();
  if (!n) return null;
  let hit = STATE.almacenProductos.find(p => p.nombre.trim().toLowerCase() === n.toLowerCase());
  if (!hit) {
    hit = { id: uid(), nombre: n, categoria: categoria || "Víveres", unidad: unidad || "", precioVentaTrabajador: 0, stock: 0 };
    STATE.almacenProductos.push(hit);
  } else if (unidad && !hit.unidad) {
    hit.unidad = unidad;
  }
  return hit;
}

/**
 * Mantiene sincronizado el movimiento de almacén (tipo "compra") ligado a una fila del
 * Diario, a partir de sus propios campos `cantidad`/`unidad`/`precioUnitario`. Se llama
 * cada vez que se agrega o edita una fila del Diario, así:
 *  - si cargás/editás la Cantidad de una compra ya existente, el stock de Almacén se
 *    actualiza al instante (sin tener que ir a otra pantalla).
 *  - si la categoría deja de ser "de almacén" (o la fila deja de ser EGRESO), se borra
 *    el movimiento vinculado (ya no corresponde tenerlo).
 *  - si la fila no tiene cantidad cargada (ej. filas viejas que ya tienen su movimiento
 *    de almacén con datos reales, o gastos que nunca tuvieron cantidad), NO se toca nada
 *    — así no se borra por accidente un movimiento real solo porque el campo esté vacío.
 */
function syncAlmacenMovimientoDesdeDiario(row) {
  const almCat = DIARIO_CATEGORIA_A_ALMACEN[row.categoria];
  const existente = STATE.almacenMovimientos.find(m => m.diarioId === row.id);
  const cantidad = Number(row.cantidad) || 0;
  const nombre = String(row.subcategoria || "").trim();

  if (!almCat || row.tipo !== "EGRESO") {
    if (existente) {
      STATE.almacenMovimientos = STATE.almacenMovimientos.filter(m => m.id !== existente.id);
      recalcStockAlmacen();
    }
    return;
  }

  if (cantidad <= 0 || !nombre) return;

  const producto = findOrCreateProductoAlmacen(nombre, almCat, row.unidad);
  const precioUnitario = Number(row.precioUnitario) || (cantidad > 0 ? (Number(row.monto) || 0) / cantidad : 0);
  const total = Number(row.monto) || 0;
  // precioVentaLote: precio de venta al trabajador de ESTE lote en particular (opcional).
  // Si no se cargó, queda sin definir y calcularColaLotesFIFO() usa el precio por defecto del producto.
  const precioVentaLote = (row.precioVentaLote != null && row.precioVentaLote !== "") ? Number(row.precioVentaLote) : undefined;

  if (existente) {
    Object.assign(existente, { fecha: row.fecha, productoId: producto.id, cantidad, precioUnitario, total, precioVentaLote, numeroComprobante: row.numeroComprobante, beneficiario: row.beneficiario, comprobante: row.comprobante, facturaCompra: row.facturaCompra });
  } else {
    STATE.almacenMovimientos.push({
      id: uid(), fecha: row.fecha, productoId: producto.id, tipo: "compra",
      cantidad, precioUnitario, total, precioVentaLote, observacion: `Compra ${producto.nombre} (vía Diario)`,
      numeroComprobante: row.numeroComprobante, beneficiario: row.beneficiario,
      comprobante: row.comprobante, facturaCompra: row.facturaCompra, diarioId: row.id
    });
  }
  recalcStockAlmacen();
}

/**
 * Mantiene sincronizado el gasto de flete de una venta de ganado (SALIDA) con una fila
 * espejo en el Diario, categoría "Flete / Transporte" (EGRESO) — así el flete pagado por
 * transportar una venta puntual entra automáticamente al Estado de Resultados y al Flujo
 * de Caja sin tener que cargarlo dos veces. Se llama cada vez que se agrega o edita un
 * movimiento de ganado:
 *  - si `fleteTotal` tiene un valor > 0 en una SALIDA, crea o actualiza la fila del Diario.
 *  - si se borra el flete (o el movimiento deja de ser SALIDA), borra la fila espejo.
 * Es asimétrico a propósito (igual que Almacén↔Diario): la fila del Diario es editable
 * directamente ahí como cualquier gasto, pero no hay sincronización de vuelta hacia el
 * movimiento de ganado si se la edita desde el Diario.
 */
function syncFleteDiarioDesdeGanado(row) {
  const existente = STATE.diario.find(d => d.ganadoMovId === row.id);
  const fleteTotal = Number(row.fleteTotal) || 0;

  if (row.tipo !== "SALIDA" || fleteTotal <= 0) {
    if (existente) STATE.diario = STATE.diario.filter(d => d.id !== existente.id);
    return;
  }

  const observaciones = `Flete venta de ganado — ${row.categoria || ""} (${Number(row.cabezas) || 0} cab.)${row.comprador ? " · " + row.comprador : ""} — generado automáticamente`;

  if (existente) {
    Object.assign(existente, { fecha: row.fecha, categoria: "Flete / Transporte", subcategoria: "Flete venta de ganado", tipo: "EGRESO", monto: fleteTotal, cuenta: row.cuenta || existente.cuenta, observaciones });
  } else {
    STATE.diario.push({
      id: uid(), fecha: row.fecha, tipo: "EGRESO", categoria: "Flete / Transporte",
      subcategoria: "Flete venta de ganado", monto: fleteTotal, cuenta: row.cuenta || "",
      observaciones, ganadoMovId: row.id
    });
  }
}

/**
 * Registra (o actualiza) la compra inicial de ganado como movimientos ENTRADA de
 * Ganado → Movimientos, uno por categoría, usando las cabezas y el Precio (Bs/cab) ya
 * cargados en Levantamiento (CREA). Es una acción EXPLÍCITA (el usuario aprieta un botón
 * aparte, no se dispara solo al guardar el levantamiento): el Levantamiento también se usa
 * para conteos físicos periódicos que NO son una compra nueva — tratarlo como compra
 * automáticamente cada vez que se guarda inflaría el Flujo de Caja/Estado de Resultados
 * con "compras" que en realidad son solo recuentos de stock.
 * Cada categoría guarda el id de su movimiento vinculado (`inventarioCreaCategorias[].entradaMovId`)
 * para que volver a apretar el botón ACTUALICE ese mismo movimiento (si se corrige el precio)
 * en vez de duplicarlo. Si una categoría se queda sin cabezas o sin precio, se borra su
 * movimiento vinculado (ya no corresponde tenerlo).
 * `datosComunes` = { cuenta, beneficiario, numeroComprobante } — se aplican a todas las
 * categorías que se registren/actualicen en esta pasada (se asume que la compra salió de
 * una sola cuenta); cada movimiento se puede corregir después individualmente en la tabla.
 */
function syncEntradaCompraDesdeLevantamiento(datosComunes) {
  const { cuenta, beneficiario, numeroComprobante } = datosComunes || {};
  const fecha = STATE.inventarioCrea.fecha || new Date().toISOString().slice(0, 10);
  let creadas = 0, actualizadas = 0, eliminadas = 0, totalBs = 0;

  STATE.categoriasGanado.forEach(cat => {
    const rec = STATE.inventarioCreaCategorias.find(r => r.categoriaId === cat.id);
    const cabezas = Number(rec && rec.cabezas) || 0;
    const precioBsCab = Number(rec && rec.precioBsCab) || 0;
    const existente = rec && rec.entradaMovId ? STATE.ganadoMovimiento.find(m => m.id === rec.entradaMovId) : null;

    if (!rec || cabezas <= 0 || precioBsCab <= 0) {
      if (existente) {
        STATE.ganadoMovimiento = STATE.ganadoMovimiento.filter(m => m.id !== existente.id);
        eliminadas++;
      }
      if (rec) rec.entradaMovId = undefined;
      return;
    }

    const monto = cabezas * precioBsCab;
    totalBs += monto;

    if (existente) {
      Object.assign(existente, {
        fecha, categoria: cat.nombre, cabezas, tipoCompra: "Por Cabeza", bsCabEntrada: precioBsCab,
        cuenta: cuenta || existente.cuenta, beneficiario: beneficiario || existente.beneficiario,
        numeroComprobante: numeroComprobante || existente.numeroComprobante
      });
      actualizadas++;
    } else {
      const nuevo = {
        id: uid(), fecha, tipo: "ENTRADA", categoria: cat.nombre, cabezas,
        tipoCompra: "Por Cabeza", bsCabEntrada: precioBsCab,
        cuenta: cuenta || "", beneficiario: beneficiario || "", numeroComprobante: numeroComprobante || "",
        observaciones: "Compra inicial de ganado (Levantamiento CREA) — generado automáticamente"
      };
      STATE.ganadoMovimiento.push(nuevo);
      rec.entradaMovId = nuevo.id;
      creadas++;
    }
  });

  saveState();
  return { creadas, actualizadas, eliminadas, totalBs };
}

/**
 * Da de alta animales individuales (con número/caravana propio) a partir de una compra
 * (ENTRADA) ya cargada en Ganado → Movimientos — para el negocio de compra-engorde-venta,
 * donde cada res que se compra entra con su propio número y así se puede rastrear el costo
 * real de ESE animal puntual desde que entra hasta que se vende. El costo por cabeza se
 * calcula del monto total de la compra (`montoTotalGanadoRow`, de calc.js) dividido entre
 * las CABEZAS DECLARADAS en el movimiento (no entre la cantidad de números que se tipeen
 * acá) — así el costo no se distorsiona si todavía faltan numerar algunos animales de esa
 * misma compra (se puede llamar esta función varias veces sobre la misma compra a medida
 * que se van areteando).
 * `numerosTexto` acepta números separados por coma, punto y coma o salto de línea. No
 * duplica: si un número ya existe en `animales` (de cualquier categoría), se omite y se
 * informa en el resultado en vez de crear un animal repetido.
 */
function registrarAnimalesDeCompra(ganadoMovId, numerosTexto) {
  const mov = STATE.ganadoMovimiento.find(m => m.id === ganadoMovId && m.tipo === "ENTRADA");
  if (!mov) return { creados: 0, omitidos: [], error: "No se encontró la compra (ENTRADA) indicada." };

  const numeros = String(numerosTexto || "")
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!numeros.length) return { creados: 0, omitidos: [], error: "No se cargó ningún número de caravana." };

  const cabezasMov = Number(mov.cabezas) || 0;
  const costoUnitario = cabezasMov > 0 ? montoTotalGanadoRow(mov) / cabezasMov : 0;

  const creados = [];
  const omitidos = [];
  numeros.forEach(numero => {
    const yaExiste = STATE.animales.find(a => (a.numero || "").trim().toLowerCase() === numero.toLowerCase());
    if (yaExiste) { omitidos.push(numero); return; }
    const animal = {
      id: uid(), numero, categoria: mov.categoria, estado: "ACTIVO",
      fechaIngreso: mov.fecha, costoCompra: Math.round(costoUnitario * 100) / 100,
      compraMovId: mov.id, observaciones: "Ingresado junto con la compra de Ganado → Movimientos"
    };
    STATE.animales.push(animal);
    creados.push(animal);
  });

  if (creados.length) syncInventarioCreaDesdeAnimales();
  saveState();
  return { creados: creados.length, omitidos, costoUnitario: Math.round(costoUnitario * 100) / 100 };
}

/**
 * Backfill complementario al de productos: si una fila del Diario ya tiene un movimiento
 * de almacén vinculado (de una compra cargada en una iteración anterior) pero la fila en
 * sí todavía no tiene sus propios campos cantidad/unidad/precioUnitario, se los copia para
 * que al editar esa fila en el Diario aparezcan los valores reales en vez de en blanco.
 */
function backfillDiarioCantidadesDesdeAlmacen(state) {
  (state.almacenMovimientos || []).forEach(m => {
    if (m.tipo !== "compra" || !m.diarioId) return;
    const row = (state.diario || []).find(r => r.id === m.diarioId);
    if (!row) return;
    if (!row.cantidad) {
      row.cantidad = m.cantidad;
      row.precioUnitario = m.precioUnitario;
      if (m.precioVentaLote != null && row.precioVentaLote == null) row.precioVentaLote = m.precioVentaLote;
      if (!row.unidad) {
        const producto = state.almacenProductos.find(p => p.id === m.productoId);
        if (producto && producto.unidad) row.unidad = producto.unidad;
      }
    }
  });
}

/**
 * Sugiere el próximo "número de compra" (para agrupar varios productos bajo un mismo
 * comprobante): el mayor número ya usado en el Diario, más uno. Si no hay ninguno numérico
 * todavía, arranca en 1. El usuario puede editar el número sugerido si prefiere otro esquema
 * (ej. el número real de la factura del proveedor).
 */
function nextNumeroCompra() {
  const nums = STATE.diario.map(r => parseInt(r.numeroCompra, 10)).filter(n => !isNaN(n));
  return nums.length ? String(Math.max(...nums) + 1) : "1";
}

/**
 * Crea en el catálogo de Almacén (sobre el `state` que se le pase) un producto por cada
 * "Producto/Detalle" distinto que ya exista en el Diario bajo una categoría inventariable
 * (Víveres, Accesorios, Sanidad, Nutrición), si todavía no está cargado. No inventa
 * cantidades ni movimientos — solo asegura que el producto exista en el catálogo.
 * Se llama automáticamente en migrateState() (cada vez que se abre la app) y también
 * se puede disparar a mano desde Almacén → Productos.
 */
function backfillAlmacenProductosEnEstado(state) {
  let creados = 0;
  (state.diario || []).forEach(row => {
    const almCat = DIARIO_CATEGORIA_A_ALMACEN[row.categoria];
    if (!almCat || !row.subcategoria) return;
    const nombre = String(row.subcategoria).trim();
    if (!nombre) return;
    const yaExiste = state.almacenProductos.some(p => p.nombre.trim().toLowerCase() === nombre.toLowerCase());
    if (!yaExiste) {
      state.almacenProductos.push({ id: uid(), nombre, categoria: almCat, unidad: "", precioVentaTrabajador: 0, stock: 0 });
      creados++;
    }
  });
  return creados;
}
function backfillAlmacenProductosDesdeDiario() {
  const creados = backfillAlmacenProductosEnEstado(STATE);
  saveState();
  return creados;
}

/* ==========================================================================
   Trabajos Sanitarios: eventos de manejo (vacunación, desparasitación, etc.)
   aplicados a una categoría/tropa de ganado, que descuentan solos el stock
   de los productos de Sanidad/Nutrición realmente usados.
   ========================================================================== */
function findOrCreateTipoTrabajoSanitario(nombre) {
  const n = String(nombre || "").trim();
  if (!n) return null;
  let hit = STATE.tiposTrabajoSanitario.find(t => t.nombre.trim().toLowerCase() === n.toLowerCase());
  if (!hit) { hit = { id: uid(), nombre: n }; STATE.tiposTrabajoSanitario.push(hit); }
  return hit;
}

/**
 * Registra un trabajo sanitario: crea la cabecera (fecha, tropa/categoría, cabezas
 * tratadas, tipo de trabajo, observaciones) y, por cada producto de Sanidad/Nutrición
 * usado, un movimiento de almacén "consumo" vinculado (que descuenta stock solo).
 * `productos` es un array [{ productoId, cantidad }].
 */
function registrarTrabajoSanitario({ fecha, categoriaGanadoId, cabezas, tipoTrabajoId, observaciones, productos }) {
  const trabajo = {
    id: uid(), fecha, categoriaGanadoId, cabezas: Number(cabezas) || 0,
    tipoTrabajoId, observaciones: observaciones || ""
  };
  STATE.trabajosSanitarios.push(trabajo);

  const categoria = STATE.categoriasGanado.find(c => c.id === categoriaGanadoId);
  const tipo = STATE.tiposTrabajoSanitario.find(t => t.id === tipoTrabajoId);
  const etiqueta = `${tipo ? tipo.nombre : "Trabajo sanitario"} — ${categoria ? categoria.nombre : "tropa"} (${fecha})`;

  (productos || []).forEach(p => {
    const cantidad = Number(p.cantidad) || 0;
    if (!p.productoId || cantidad <= 0) return;
    const producto = STATE.almacenProductos.find(x => x.id === p.productoId);
    if (!producto) return;
    STATE.almacenMovimientos.push({
      id: uid(), fecha, productoId: producto.id, tipo: "consumo",
      cantidad, precioUnitario: 0, total: 0,
      trabajoSanitarioId: trabajo.id,
      observacion: etiqueta
    });
  });

  recalcStockAlmacen();
  saveState();
  return trabajo;
}

/** Devuelve los movimientos de almacén (consumo de productos) ligados a un trabajo sanitario. */
function productosDeTrabajoSanitario(trabajoId) {
  return STATE.almacenMovimientos.filter(m => m.trabajoSanitarioId === trabajoId);
}

/** Borra un trabajo sanitario y todos sus consumos de almacén vinculados (el stock se recalcula). */
function eliminarTrabajoSanitario(id) {
  STATE.trabajosSanitarios = STATE.trabajosSanitarios.filter(t => t.id !== id);
  const antes = STATE.almacenMovimientos.length;
  STATE.almacenMovimientos = STATE.almacenMovimientos.filter(m => m.trabajoSanitarioId !== id);
  if (STATE.almacenMovimientos.length !== antes) recalcStockAlmacen();
  saveState();
}

/* ==========================================================================
   Inventario individual de ganado (numeración/caravana) — import desde Excel
   ========================================================================== */
function findOrCreateCategoriaGanado(nombre) {
  const n = String(nombre || "").trim();
  if (!n) return null;
  let hit = STATE.categoriasGanado.find(c => c.nombre.trim().toLowerCase() === n.toLowerCase());
  if (!hit) {
    hit = { id: uid(), nombre: n, coefEV: 1 };
    STATE.categoriasGanado.push(hit);
  }
  return hit;
}

function normalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ANIMAL_FIELD_ALIASES = {
  numero: ["numero caravana", "n caravana", "numero", "nro", "caravana", "identificacion", "codigo", "id animal"],
  marcaOrigen: ["marca origen", "marca de origen", "marca de compra", "marca compra", "marca"],
  categoria: ["categoria animal", "categoria", "clase", "tipo animal"],
  colorArete: ["color arete", "color de arete", "arete color", "arete"],
  sexo: ["sexo", "genero"],
  pesoKg: ["peso vivo", "peso actual", "peso kg", "peso"],
  fechaNacimiento: ["fecha nacimiento", "fecha nac", "nacimiento"],
  fechaIngreso: ["fecha ingreso", "fecha compra", "ingreso"],
  potrero: ["potrero lote", "potrero", "lote", "ubicacion"],
  madre: ["madre caravana", "madre"],
  estado: ["estado", "situacion"],
  observaciones: ["observaciones", "notas", "obs", "nota"]
};

function mapAnimalHeaders(headerRow) {
  const map = {};
  (headerRow || []).forEach((h, idx) => {
    const nh = normalizeHeader(h);
    if (!nh) return;
    for (const [field, aliases] of Object.entries(ANIMAL_FIELD_ALIASES)) {
      if (map[field] != null) continue;
      if (aliases.some(a => nh === a || nh.includes(a))) { map[field] = idx; break; }
    }
  });
  return map;
}

/**
 * Recalcula el "stock inicial" (levantamiento CREA) por categoría a partir
 * del inventario individual de animales (los que están ACTIVO). No borra
 * nada de lo cargado manualmente si esa categoría NUNCA tuvo animales individuales
 * cargados (para no pisar un número aggregate que el usuario cargó a mano). Pero si la
 * categoría SÍ tiene (o tuvo) animales individuales, `cabezas` se actualiza siempre al
 * conteo real de ACTIVO — incluso si baja a 0 (ej. se vendieron todos los numerados de
 * esa categoría) — para no dejar un número inflado y stale que ya no representa nada.
 */
function syncInventarioCreaDesdeAnimales() {
  if (!STATE.animales.length) return;
  STATE.categoriasGanado.forEach(cat => {
    const nombreLower = cat.nombre.trim().toLowerCase();
    const todosDeEstaCategoria = STATE.animales.filter(a => (a.categoria || "").trim().toLowerCase() === nombreLower);
    if (!todosDeEstaCategoria.length) return; // esta categoría nunca tuvo animales individuales: no tocar el número manual
    const activos = todosDeEstaCategoria.filter(a => (a.estado || "ACTIVO").toUpperCase() === "ACTIVO");
    const pesos = activos.map(a => Number(a.pesoKg) || 0).filter(p => p > 0);
    const pesoProm = pesos.length ? Math.round((pesos.reduce((a, b) => a + b, 0) / pesos.length) * 100) / 100 : 0;
    let rec = STATE.inventarioCreaCategorias.find(r => r.categoriaId === cat.id);
    if (!rec) { rec = { categoriaId: cat.id, cabezas: 0, pesoProm: 0, precioBsCab: 0 }; STATE.inventarioCreaCategorias.push(rec); }
    rec.cabezas = activos.length;
    if (pesoProm) rec.pesoProm = pesoProm;
  });
  STATE.inventarioCrea.fecha = new Date().toISOString().slice(0, 10);
}

/**
 * Importa una planilla Excel propia (existencias + numeración de animales)
 * y arma/actualiza el inventario individual de ganado. Reconoce encabezados
 * habituales en español (Número/Caravana, Categoría, Sexo, Peso, Fecha,
 * Potrero, Estado, Observaciones) sin importar el orden de las columnas.
 * Si aparece una categoría nueva, se crea sola en Configuración.
 */
async function importInventarioAnimalesExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const sheetName = wb.SheetNames.find(n => /animal|inventario|existenc|rodeo|ganado/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  if (!rows || !rows.length) throw new Error("La planilla está vacía.");

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const filled = (rows[i] || []).filter(c => c != null && String(c).trim() !== "").length;
    if (filled >= 2) { headerRowIdx = i; break; }
  }
  const headerRow = rows[headerRowIdx];
  const colMap = mapAnimalHeaders(headerRow);

  if (colMap.numero == null && colMap.categoria == null) {
    throw new Error("No se reconocieron columnas de número/caravana ni categoría. Revisá los encabezados de la primera fila.");
  }

  let importados = 0;
  const categoriasVistas = new Set();

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => c == null || String(c).trim() === "")) continue;
    const numero = colMap.numero != null ? r[colMap.numero] : "";
    const categoriaNombre = colMap.categoria != null ? r[colMap.categoria] : "";
    if (!numero && !categoriaNombre) continue;

    const cat = findOrCreateCategoriaGanado(categoriaNombre || "Sin categoría");
    categoriasVistas.add(cat ? cat.nombre : "");

    STATE.animales.push({
      id: uid(),
      numero: numero != null ? String(numero).trim() : "",
      marcaOrigen: colMap.marcaOrigen != null ? String(r[colMap.marcaOrigen] || "").trim() : "",
      categoria: cat ? cat.nombre : (categoriaNombre || "Sin categoría"),
      colorArete: colMap.colorArete != null ? String(r[colMap.colorArete] || "").trim() : "",
      sexo: colMap.sexo != null ? String(r[colMap.sexo] || "").trim() : "",
      pesoKg: colMap.pesoKg != null ? Number(r[colMap.pesoKg]) || 0 : 0,
      fechaNacimiento: colMap.fechaNacimiento != null ? excelSerialToISO(r[colMap.fechaNacimiento]) : "",
      fechaIngreso: colMap.fechaIngreso != null ? excelSerialToISO(r[colMap.fechaIngreso]) : "",
      potrero: colMap.potrero != null ? String(r[colMap.potrero] || "").trim() : "",
      madre: colMap.madre != null ? String(r[colMap.madre] || "").trim() : "",
      estado: colMap.estado != null ? (String(r[colMap.estado] || "ACTIVO").trim().toUpperCase() || "ACTIVO") : "ACTIVO",
      observaciones: colMap.observaciones != null ? String(r[colMap.observaciones] || "").trim() : ""
    });
    importados++;
  }

  syncInventarioCreaDesdeAnimales();
  saveState();
  return { importados, categorias: categoriasVistas.size, total: STATE.animales.length };
}

/**
 * Genera una planilla Excel modelo para que el usuario la use como base
 * de su propio inventario de animales (columnas que la app reconoce).
 */
function exportPlantillaAnimales() {
  const headers = ["NUMERO/CARAVANA", "MARCA ORIGEN", "CATEGORIA", "COLOR ARETE", "SEXO", "PESO_KG", "FECHA_NACIMIENTO", "FECHA_INGRESO", "POTRERO/LOTE", "MADRE", "ESTADO", "OBSERVACIONES"];
  const ejemplo = ["A-001", "F", "Vaca", "Verde", "H", 380, "2021-03-15", "", "Potrero 3", "", "ACTIVO", ""];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ejemplo]), "INVENTARIO_ANIMALES");
  XLSX.writeFile(wb, "Plantilla_Inventario_Animales.xlsx");
}

/* ==========================================================================
   Import / Export Excel (SheetJS)
   ========================================================================== */

function sheetToRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

function excelSerialToISO(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return "";
    const mm = String(d.m).padStart(2, "0");
    const dd = String(d.d).padStart(2, "0");
    return `${d.y}-${mm}-${dd}`;
  }
  // texto tipo dd/mm/aaaa
  const m = String(v).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  const d2 = new Date(v);
  if (!isNaN(d2)) return d2.toISOString().slice(0,10);
  return "";
}

function findCategoriaIdByNombre(nombre) {
  if (!nombre) return null;
  const n = String(nombre).trim().toLowerCase();
  const hit = STATE.categoriasGanado.find(c => c.nombre.trim().toLowerCase() === n);
  return hit ? hit.id : null;
}

/**
 * Importa un archivo Estancia_Ganadera_Costos.xlsx (estructura del proyecto)
 * y fusiona sus datos dentro del STATE actual de la app.
 */
async function importExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  let importedCounts = { diario: 0, ganado: 0, empleados: 0, gastosFijos: 0 };

  // --- DIARIO ---
  const diarioRows = sheetToRows(wb, "DIARIO");
  if (diarioRows) {
    for (let i = 3; i < diarioRows.length; i++) {
      const r = diarioRows[i];
      if (!r || !r[0]) continue; // sin fecha -> vacío
      STATE.diario.push({
        id: uid(),
        fecha: excelSerialToISO(r[0]),
        tipo: (r[1] || "EGRESO").toString().toUpperCase(),
        categoria: r[2] || "",
        descripcion: r[3] || "",
        cuenta: r[4] || "",
        monto: Number(r[5]) || 0
      });
      importedCounts.diario++;
    }
  }

  // --- GANADO_MOVIMIENTO ---
  const ganadoRows = sheetToRows(wb, "GANADO_MOVIMIENTO");
  if (ganadoRows) {
    for (let i = 4; i < ganadoRows.length; i++) {
      const r = ganadoRows[i];
      if (!r || !r[0]) continue;
      STATE.ganadoMovimiento.push({
        id: uid(),
        fecha: excelSerialToISO(r[0]),
        tipo: (r[1] || "ENTRADA").toString().toUpperCase(),
        categoria: r[2] || "",
        cabezas: Number(r[3]) || 0,
        kgEntrada: Number(r[4]) || 0,
        bsKgEntrada: Number(r[5]) || 0,
        tipoVenta: r[7] || "Kilo Vivo",
        kgSalida: Number(r[8]) || 0,
        bsKgSalida: Number(r[9]) || 0,
        kgGanchoSalida: Number(r[10]) || 0,
        bsKgGanchoSalida: Number(r[11]) || 0,
        rendimientoPct: Number(r[12]) || 0,
        montoTotalSalida: Number(r[13]) || 0,
        destino: r[15] || "",
        comprador: r[16] || "",
        cuenta: r[17] || "",
        observaciones: r[18] || ""
      });
      importedCounts.ganado++;
    }
  }

  // --- SUELDOS (solo cargos + valores, si tienen datos) ---
  const suRows = sheetToRows(wb, "SUELDOS");
  if (suRows) {
    for (let i = 3; i < suRows.length; i++) {
      const r = suRows[i];
      if (!r || !r[0] || String(r[0]).startsWith("TOTAL")) continue;
      const existing = STATE.empleados.find(e => e.cargo === r[0]);
      const patch = {
        cargo: r[0],
        cantidad: Number(r[1]) || 1,
        haberBasico: Number(r[2]) || 0,
        bonoProd: Number(r[3]) || 0
      };
      if (existing) Object.assign(existing, patch);
      else STATE.empleados.push({ id: uid(), ...patch });
      importedCounts.empleados++;
    }
  }

  // --- GASTOS_FIJOS ---
  const gfRows = sheetToRows(wb, "GASTOS_FIJOS");
  if (gfRows) {
    for (let i = 3; i < gfRows.length; i++) {
      const r = gfRows[i];
      if (!r || !r[0] || String(r[0]).startsWith("TOTAL")) continue;
      const existing = STATE.gastosFijos.find(g => g.concepto === r[0]);
      const patch = { concepto: r[0], importeMensual: Number(r[1]) || 0, observaciones: r[4] || "" };
      if (existing) Object.assign(existing, patch);
      else STATE.gastosFijos.push({ id: uid(), ...patch });
      importedCounts.gastosFijos++;
    }
  }

  // --- ANIMALES (inventario individual, si el backup lo trae) ---
  const animalesRows = sheetToRows(wb, "ANIMALES");
  if (animalesRows) {
    for (let i = 1; i < animalesRows.length; i++) {
      const r = animalesRows[i];
      if (!r || (!r[0] && !r[1])) continue;
      STATE.animales.push({
        id: uid(),
        numero: r[0] || "",
        categoria: r[1] || "",
        sexo: r[2] || "",
        pesoKg: Number(r[3]) || 0,
        fechaNacimiento: r[4] || "",
        fechaIngreso: r[5] || "",
        potrero: r[6] || "",
        madre: r[7] || "",
        estado: (r[8] || "ACTIVO").toString().toUpperCase(),
        observaciones: r[9] || "",
        marcaOrigen: r[10] || "",
        colorArete: r[11] || ""
      });
    }
    syncInventarioCreaDesdeAnimales();
  }

  // --- ALMACEN_PRODUCTOS ---
  const almProdRows = sheetToRows(wb, "ALMACEN_PRODUCTOS");
  if (almProdRows) {
    for (let i = 1; i < almProdRows.length; i++) {
      const r = almProdRows[i];
      if (!r || !r[0]) continue;
      STATE.almacenProductos.push({
        id: uid(), nombre: r[0] || "", categoria: r[1] || "Víveres", unidad: r[2] || "",
        precioVentaTrabajador: Number(r[3]) || 0, stock: 0
      });
    }
  }

  // --- ALMACEN_MOVIMIENTOS ---
  const almMovRows = sheetToRows(wb, "ALMACEN_MOVIMIENTOS");
  if (almMovRows) {
    for (let i = 1; i < almMovRows.length; i++) {
      const r = almMovRows[i];
      if (!r || !r[0]) continue;
      const producto = STATE.almacenProductos.find(p => p.nombre === r[1]);
      if (!producto) continue;
      STATE.almacenMovimientos.push({
        id: uid(), fecha: excelSerialToISO(r[0]), productoId: producto.id, tipo: r[2] || "compra",
        cantidad: Number(r[3]) || 0, precioUnitario: Number(r[4]) || 0, total: Number(r[5]) || 0,
        observacion: r[6] || ""
      });
    }
    recalcStockAlmacen();
  }

  saveState();
  return importedCounts;
}

function aoa(rows) {
  return XLSX.utils.aoa_to_sheet(rows);
}

/**
 * Exporta el estado actual de la app a un libro .xlsx de respaldo
 * (valores calculados, no fórmulas — pensado como backup / para compartir).
 */
function exportExcelFile() {
  const wb = XLSX.utils.book_new();
  const anio = STATE.meta.anio;

  // DIARIO
  const diarioRows = [
    ["FECHA", "TIPO", "CATEGORÍA", "DESCRIPCIÓN", "CUENTA", "MONTO (Bs)"],
    ...STATE.diario
      .slice()
      .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""))
      .map(r => [r.fecha, r.tipo, r.categoria, r.descripcion, r.cuenta, r.monto])
  ];
  XLSX.utils.book_append_sheet(wb, aoa(diarioRows), "DIARIO");

  // GANADO_MOVIMIENTO
  const ganadoRows = [
    ["FECHA", "TIPO", "CATEGORÍA", "CABEZAS", "KG ENTRADA", "Bs/KG ENTRADA", "TOTAL ENTRADA",
     "TIPO VENTA", "KG SALIDA (vivo)", "Bs/KG SALIDA (vivo)", "KG GANCHO", "Bs/KG GANCHO", "RENDIMIENTO %",
     "MONTO AL BULTO (Bs)", "TOTAL SALIDA (Bs)", "DESTINO", "COMPRADOR", "CUENTA", "OBSERVACIONES"],
    ...STATE.ganadoMovimiento
      .slice()
      .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""))
      .map(r => [
        r.fecha, r.tipo, r.categoria, r.cabezas,
        r.kgEntrada, r.bsKgEntrada, (r.kgEntrada||0)*(r.bsKgEntrada||0),
        r.tipoVenta || "", r.kgSalida, r.bsKgSalida, r.kgGanchoSalida, r.bsKgGanchoSalida, r.rendimientoPct,
        r.montoTotalSalida, montoTotalGanadoRow(r),
        r.destino || "", r.comprador || "", r.cuenta, r.observaciones
      ])
  ];
  XLSX.utils.book_append_sheet(wb, aoa(ganadoRows), "GANADO_MOVIMIENTO");

  // SUELDOS
  const sueldos = calcSueldos(STATE);
  const sueldosRows = [
    ["CARGO", "CANT.", "HABER BÁSICO", "BONO PROD.", "TOTAL MENSUAL", "APORTE AFP", "COSTO TOTAL MES", "COSTO ANUAL"],
    ...sueldos.filas.map(f => [f.cargo, f.cantidad, f.haberBasico, f.bonoProd, f.totalMensual, f.aporteAfp, f.costoTotalMes, f.costoAnual]),
    ["TOTAL", "", "", "", sueldos.totalMensual, sueldos.totalAporte, sueldos.totalCostoMes, sueldos.totalCostoAnual]
  ];
  XLSX.utils.book_append_sheet(wb, aoa(sueldosRows), "SUELDOS");

  // GASTOS_FIJOS
  const gf = calcGastosFijos(STATE);
  const gfRows = [
    ["CONCEPTO", "IMPORTE MENSUAL", "IMPORTE ANUAL", "% DEL TOTAL", "OBSERVACIONES"],
    ...gf.filas.map(f => [f.concepto, f.importeMensual, f.importeAnual, f.pct, f.observaciones]),
    ["TOTAL", gf.totalMensual, gf.totalAnual, 1, ""]
  ];
  XLSX.utils.book_append_sheet(wb, aoa(gfRows), "GASTOS_FIJOS");

  // GASTOS_VARIABLES
  const gv = calcGastosVariables(STATE);
  const gvRows = [
    ["SECCIÓN", "CONCEPTO", "UNIDAD", "CANTIDAD MES", "P. UNIT.", "IMPORTE MES", "OBSERVACIONES"],
    ...gv.filas.map(f => [f.seccion, f.concepto, f.unidad, f.cantidadMes, f.precioUnit, f.importeMes, f.observaciones]),
    ["TOTAL", "", "", "", "", gv.total, ""]
  ];
  XLSX.utils.book_append_sheet(wb, aoa(gvRows), "GASTOS_VARIABLES");

  // GANADO_INVENTARIO
  const inv = calcGanadoInventario(STATE);
  const invRows = [
    ["CATEGORÍA", "STOCK INICIAL", "ENTRADAS", "NACIMIENTOS", "SALIDAS", "MUERTES", "STOCK ACTUAL", "COEF. EV", "EV ACTUAL", "PRECIO Bs/CAB", "VALOR ACTUAL", "VALOR INICIAL"],
    ...inv.filas.map(f => [f.categoria, f.stockInicial, f.entradas, f.nacimientos, f.salidas, f.muertes, f.stockActual, f.coefEV, f.evActual, f.precioBsCab, f.valorActual, f.valorInicial]),
    ["TOTAL", inv.totalStockInicial, inv.totalEntradas, inv.totalNacimientos, inv.totalSalidas, inv.totalMuertes, inv.totalStockActual, "", inv.totalEV, "", inv.totalValorActual, inv.totalValorInicial]
  ];
  XLSX.utils.book_append_sheet(wb, aoa(invRows), "GANADO_INVENTARIO");

  // ANIMALES (inventario individual con numeración/caravana)
  const animalesRows = [
    ["NUMERO", "CATEGORIA", "SEXO", "PESO_KG", "FECHA_NACIMIENTO", "FECHA_INGRESO", "POTRERO", "MADRE", "ESTADO", "OBSERVACIONES", "MARCA_ORIGEN", "COLOR_ARETE"],
    ...STATE.animales.map(a => [a.numero, a.categoria, a.sexo, a.pesoKg, a.fechaNacimiento, a.fechaIngreso, a.potrero, a.madre, a.estado, a.observaciones, a.marcaOrigen || "", a.colorArete || ""])
  ];
  XLSX.utils.book_append_sheet(wb, aoa(animalesRows), "ANIMALES");

  // ALMACEN_PRODUCTOS
  const almProdRows = [
    ["PRODUCTO", "CATEGORIA", "UNIDAD", "PRECIO_VENTA_TRABAJADOR", "STOCK_ACTUAL"],
    ...STATE.almacenProductos.map(p => [p.nombre, p.categoria, p.unidad, p.precioVentaTrabajador, p.stock || 0])
  ];
  XLSX.utils.book_append_sheet(wb, aoa(almProdRows), "ALMACEN_PRODUCTOS");

  // ALMACEN_MOVIMIENTOS
  const almMovRows = [
    ["FECHA", "PRODUCTO", "TIPO", "CANTIDAD", "PRECIO_UNITARIO", "TOTAL", "OBSERVACION"],
    ...STATE.almacenMovimientos
      .slice()
      .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""))
      .map(m => {
        const p = STATE.almacenProductos.find(x => x.id === m.productoId);
        return [m.fecha, p ? p.nombre : "", m.tipo, m.cantidad, m.precioUnitario, m.total, m.observacion];
    })
  ];
  XLSX.utils.book_append_sheet(wb, aoa(almMovRows), "ALMACEN_MOVIMIENTOS");

  // ESTADO_RESULTADO
  const er = calcEstadoResultado(STATE, anio);
  const meses = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];
  const erRows = [
    ["CONCEPTO", ...meses, "TOTAL AÑO"],
    ["Venta de Ganado", ...er.ventaGanado, er.ventaGanado.reduce((a,b)=>a+b,0)],
    ["Venta de Subproductos", ...er.ventaSubproductos, er.ventaSubproductos.reduce((a,b)=>a+b,0)],
    ["Otros Ingresos", ...er.otrosIngresos, er.otrosIngresos.reduce((a,b)=>a+b,0)],
    ["Variación de inventario", ...meses.map(()=>""), er.variacionInventario],
    ["TOTAL INGRESOS", ...er.totalIngresosMes, er.totalIngresosAnio],
    ["Compra de Ganado", ...er.compraGanado, er.compraGanado.reduce((a,b)=>a+b,0)],
    ...er.costosDirectosDetalle.map(c => [c.nombre, ...c.valores, c.valores.reduce((a,b)=>a+b,0)]),
    ["TOTAL COSTOS DIRECTOS", ...er.totalCostosDirectosMes, er.totalCostosDirectosAnio],
    ["MARGEN BRUTO", ...er.margenBrutoMes, er.margenBrutoAnio],
    ...er.estructuraDetalle.map(c => [c.nombre, ...c.valores, c.valores.reduce((a,b)=>a+b,0)]),
    ["Depreciación", ...er.depreciacionMes, er.depreciacionMes.reduce((a,b)=>a+b,0)],
    ["TOTAL ESTRUCTURA", ...er.totalEstructuraMes, er.totalEstructuraAnio],
    ["RESULTADO OPERATIVO", ...er.resultadoMes, er.resultadoAnio]
  ];
  XLSX.utils.book_append_sheet(wb, aoa(erRows), "ESTADO_RESULTADO");

  const filename = `Estancia_Backup_${STATE.meta.nombreEstancia.replace(/\s+/g,"_")}_${anio}.xlsx`;
  XLSX.writeFile(wb, filename);
}
