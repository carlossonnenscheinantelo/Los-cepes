/* ==========================================================================
   render.js — construcción de vistas (HTML) + wiring de eventos.
   Cada vista se re-genera por completo en cada cambio (app de uso personal,
   volumen de datos bajo => performance no es un problema).
   ========================================================================== */

const VIEW_TITLES = {
  inicio: "Inicio",
  diario: "Diario de Gastos e Ingresos",
  ganado: "Ganado",
  personal: "Personal y Sueldos",
  almacen: "Almacén",
  comprobantes: "Comprobantes",
  "gastos-fijos": "Gastos Fijos Mensuales",
  "gastos-variables": "Gastos Variables Mensuales",
  financiero: "Estados Financieros",
  analisis: "Análisis y Rentabilidad",
  configuracion: "Configuración",
  datos: "Datos / Excel"
};

const uiState = {
  currentView: "inicio",
  diarioTab: "general",
  ganadoTab: "movimientos",
  personalTab: "sueldos",
  personalWorkerId: null,
  financieroTab: "resultado",
  almacenTab: "productos",
  almacenKardexProductoId: null,
  comprobantesFiltro: { texto: "", origen: "todos", desde: "", hasta: "" }
};

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// Convierte "YYYY-MM-DD" → "DD/MM/YYYY". Cualquier otro formato lo devuelve tal cual.
function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : escapeHtml(iso);
}

function resolveOptions(opt) { return typeof opt === "function" ? opt() : opt; }

/* ==========================================================================
   Comprobantes (fotos de facturas/recibos) — se guardan como imagen
   comprimida en base64 dentro del propio registro (sin servidor).
   ========================================================================== */
function fileToCompressedDataURL(file, maxWidth = 800, quality = 0.6) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(""); return; }
    if (!file.type || !file.type.startsWith("image/")) {
      reject(new Error("El archivo debe ser una imagen (foto o captura)."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("No se pudo procesar la imagen."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ==========================================================================
   Lightbox genérico: cualquier <img class="lightbox-trigger"> en toda la app
   se puede tocar/clickear para verse en grande, sin navegar a otra pestaña.
   ========================================================================== */
function openLightbox(src, caption) {
  let overlay = document.getElementById("lightboxOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "lightboxOverlay";
    overlay.className = "lightbox-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => {
      if (e.target === overlay || e.target.closest(".lightbox-close")) closeLightbox();
    });
  }
  overlay.innerHTML = `
    <div class="lightbox-box">
      <button type="button" class="lightbox-close" aria-label="Cerrar">✕</button>
      <img src="${src}" class="lightbox-img" alt="Comprobante ampliado">
      ${caption ? `<div class="lightbox-caption">${caption}</div>` : ""}
    </div>`;
  overlay.classList.add("show");
}
function closeLightbox() {
  const overlay = document.getElementById("lightboxOverlay");
  if (overlay) overlay.classList.remove("show");
}
document.addEventListener("click", e => {
  const img = e.target.closest("img.lightbox-trigger");
  if (!img) return;
  openLightbox(img.currentSrc || img.src, img.dataset.lightboxCaption || "");
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeLightbox();
});

/* ==========================================================================
   OCR de comprobantes (Tesseract.js, corre 100% en el navegador, sin
   servidor): al subir la foto, intenta leer el Nº de comprobante impreso
   y completar el campo solo. Nunca pisa un valor que el usuario ya escribió.
   Requiere internet la primera vez (descarga el motor de OCR, ~algunos MB);
   las veces siguientes el navegador ya lo tiene cacheado.
   ========================================================================== */
let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (typeof Tesseract === "undefined")
      ? Promise.reject(new Error("Tesseract.js no está disponible (¿sin internet la primera vez?)"))
      : Tesseract.createWorker("eng");
  }
  return ocrWorkerPromise;
}

// Busca el número de comprobante dentro del texto crudo que devuelve el OCR.
// Prioriza números pegados a una palabra clave (Nº/Nro/Factura/Recibo/Folio/
// Comprobante) para no confundirlo con una fecha, un monto o un NIT.
function extraerNumeroComprobante(texto) {
  if (!texto) return "";
  const limpio = texto.replace(/\r/g, "");
  const patrones = [
    /(?:factura|recibo|comprobante|folio)[^\d]{0,25}(\d{3,10})/i,
    /\bnro\.?[^\d]{0,20}(\d{3,10})/i,
    /n[°ºªo]{1,2}\.?[^\d]{0,20}(\d{3,10})/i
  ];
  for (const re of patrones) {
    const m = limpio.match(re);
    if (m) return m[1];
  }
  return "";
}

// Convierte un número tal como aparece escrito en el comprobante ("1.500,00",
// "1,500.00", "150,00", "150.00", "150") a un float con punto decimal (formato
// que entiende <input type="number">). Si tiene coma Y punto, el símbolo que
// aparece último es el separador decimal; el otro se asume separador de miles.
function normalizarMontoOCR(raw) {
  if (!raw) return null;
  let s = raw.trim();
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const partes = s.split(",");
    s = partes[partes.length - 1].length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const num = parseFloat(s);
  return isFinite(num) ? num : null;
}

// Busca el monto total del comprobante en el texto del OCR, probando varias
// señales de más a menos confiable: 1) una palabra clave de "total" (con
// bastante tolerancia de texto/símbolos de moneda en el medio, porque muchos
// recibos ponen puntos de relleno tipo "TOTAL ......... 150.00"); 2) frases
// típicas de recibo manuscrito boliviano ("son:", "recibí la suma de");
// 3) cualquier mención de "Bs" seguida de número; 4) como último recurso, el
// número con formato de plata (dos decimales) más grande de todo el texto —
// asume que el total suele ser el monto más alto en la factura/recibo.
function extraerMontoComprobante(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/\r/g, "");
  const numero = "(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{2})?)";
  const patrones = [
    new RegExp(`\\btotal\\b\\s*(?:a\\s*pagar|general)?[^\\d]{0,25}${numero}`, "i"),
    new RegExp(`\\b(?:son|importe|cancel[oó])\\b[^\\d]{0,20}${numero}`, "i"),
    new RegExp(`\\bbs\\.?\\s*[:\\-]?\\s*${numero}`, "i")
  ];
  for (const re of patrones) {
    const m = limpio.match(re);
    if (m) {
      const n = normalizarMontoOCR(m[1]);
      if (n != null && n > 0) return n;
    }
  }
  // Último recurso: el importe con dos decimales más grande de todo el texto.
  const conDecimales = [...limpio.matchAll(/\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/g)]
    .map(m => normalizarMontoOCR(m[0]))
    .filter(n => n != null && n > 0);
  if (conDecimales.length) return Math.max(...conDecimales);
  return null;
}

function flashOcrFilled(el) {
  el.classList.add("ocr-filled");
  setTimeout(() => el.classList.remove("ocr-filled"), 2500);
}

// Convierte día/mes/año (tal como los capturó la regex, con año de 2 o 4
// dígitos) a "YYYY-MM-DD" (formato que espera <input type="date">). Devuelve
// null si la fecha es inválida o si el año queda fuera de un rango razonable
// (probable falso positivo del OCR, ej. un NIT o un código de barras).
function normalizarFechaOCR(ddStr, mmStr, yyyyStr) {
  let d = parseInt(ddStr, 10), m = parseInt(mmStr, 10), y = parseInt(yyyyStr, 10);
  if (yyyyStr.length <= 2) y = 2000 + y; // asume siglo 21
  if (m > 12 && d <= 12) { const t = d; d = m; m = t; } // por si vino como MM/DD
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;
  const anioActual = new Date().getFullYear();
  if (y < anioActual - 10 || y > anioActual + 1) return null;
  const pad = n => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

const MESES_TEXTO = {
  enero:1, ene:1, febrero:2, feb:2, marzo:3, mar:3, abril:4, abr:4, mayo:5, may:5,
  junio:6, jun:6, julio:7, jul:7, agosto:8, ago:8, septiembre:9, setiembre:9, sep:9, set:9,
  octubre:10, oct:10, noviembre:11, nov:11, diciembre:12, dic:12
};
const MESES_TEXTO_RE = Object.keys(MESES_TEXTO).sort((a, b) => b.length - a.length).join("|");

// Busca una fecha en el texto del OCR probando varios formatos, de más a
// menos confiable: DD/MM/AAAA cerca de la palabra "FECHA" → AAAA-MM-DD (ISO)
// cerca de "FECHA" → DD/MM/AAAA en cualquier parte → AAAA-MM-DD en cualquier
// parte → mes escrito en palabras ("4 de julio de 2026", abreviado o no).
function extraerFechaComprobante(texto) {
  if (!texto) return "";
  const limpio = texto.replace(/\r/g, "");

  const conEtiqueta = limpio.match(/fecha[^\d]{0,15}(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/i);
  if (conEtiqueta) {
    const f = normalizarFechaOCR(conEtiqueta[1], conEtiqueta[2], conEtiqueta[3]);
    if (f) return f;
  }
  const isoConEtiqueta = limpio.match(/fecha[^\d]{0,15}(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/i);
  if (isoConEtiqueta) {
    const f = normalizarFechaOCR(isoConEtiqueta[3], isoConEtiqueta[2], isoConEtiqueta[1]);
    if (f) return f;
  }
  const cualquiera = limpio.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (cualquiera) {
    const f = normalizarFechaOCR(cualquiera[1], cualquiera[2], cualquiera[3]);
    if (f) return f;
  }
  // Formato AAAA-MM-DD / AAAA/MM/DD (ISO), típico de sistemas de facturación.
  const iso = limpio.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
  if (iso) {
    const f = normalizarFechaOCR(iso[3], iso[2], iso[1]);
    if (f) return f;
  }
  // Fechas escritas con el mes en palabras, completo o abreviado (ej. "4 de
  // julio de 2026", "04 jul 2026", "04-Jul-26", "2 de Abril, 2026"), comunes
  // en recibos manuscritos, apps de bancos o facturas formales. Se tolera una
  // coma entre el mes y el año (ej. apps de pago QR que escriben "Abril,
  // 2026") además de los separadores ya soportados.
  const textualRe = new RegExp(`(\\d{1,2})[\\s,]*(?:de|[\\-.\\/])?[\\s,]*(${MESES_TEXTO_RE})[\\s,.]*(?:de|del|[\\-.\\/])?[\\s,]*(\\d{2,4})`, "i");
  const textual = limpio.match(textualRe);
  if (textual) {
    const mes = MESES_TEXTO[textual[2].toLowerCase()];
    const f = normalizarFechaOCR(textual[1], String(mes), textual[3]);
    if (f) return f;
  }
  return "";
}

// Un campo de fecha se considera "autocompletable" si está vacío o si todavía
// tiene el valor por defecto (hoy) que la app le puso al abrir el formulario
// — o sea, el usuario todavía no lo tocó a mano. Si ya lo cambió, no se pisa.
function fechaEsAutocompletable(inputEl) {
  if (!inputEl) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return !inputEl.value || inputEl.value === hoy;
}

function limpiarNombreOCR(raw) {
  const s = raw.split("\n")[0].trim().replace(/\s{2,}/g, " ").replace(/[:\-.,]+$/, "").trim();
  return s.length >= 3 ? s : "";
}

// Descarta líneas que claramente no son un nombre de persona/negocio (solo
// números, o palabras típicas de encabezado de recibo/factura).
function esNombrePosible(linea) {
  if (!linea || linea.length < 3 || linea.length > 45) return false;
  if (/^\d+$/.test(linea)) return false;
  if (/^(factura|recibo|comprobante|nit|fecha|total|subtotal|bs\.?|original|copia|cliente|se[ñn]or|se[ñn]ora)\b/i.test(linea)) return false;
  const letras = (linea.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return letras >= 3;
}

// Busca el nombre que aparece pegado (misma línea) o inmediatamente debajo
// (hasta 3 líneas después) de una etiqueta dada. Se usa para comprobantes de
// transferencia bancaria / QR, donde el nombre del destinatario casi siempre
// aparece como una línea suelta justo debajo de "Cuenta de destino" (sin dos
// puntos ni ninguna otra marca), no como "Etiqueta: Nombre" en una sola línea.
function extraerLineaCercaDeEtiqueta(texto, etiquetaRegex, mismaLineaRegex) {
  const mismaLinea = texto.match(mismaLineaRegex);
  if (mismaLinea) {
    const nombre = limpiarNombreOCR(mismaLinea[1]);
    if (nombre) return nombre;
  }
  const lineas = texto.split("\n").map(l => l.trim());
  for (let i = 0; i < lineas.length; i++) {
    if (!etiquetaRegex.test(lineas[i])) continue;
    for (let j = i + 1; j < lineas.length && j <= i + 3; j++) {
      if (!lineas[j]) continue;
      if (esNombrePosible(lineas[j])) return limpiarNombreOCR(lineas[j]);
      break; // la siguiente línea con contenido no parece nombre — no seguir buscando más lejos
    }
  }
  return "";
}

// Intenta identificar al VENDEDOR / DESTINATARIO (a quién se le pagó) — no al
// cliente/comprador. OJO: en la mayoría de facturas y recibos bolivianos,
// campos como "Cliente:", "Señor(a):" o "Nombre/Razón Social:" identifican al
// COMPRADOR (el usuario o su estancia), no al vendedor — por eso se ignoran a
// propósito. Se prueba, de más a menos confiable: 1) comprobantes de
// transferencia/QR bancario, donde el nombre real del destinatario está en la
// línea debajo de "Cuenta de destino"; 2) campos explícitos del vendedor
// ("Proveedor", "Vendedor", "Emisor", "Razón Social del emisor/proveedor");
// 3) si no hay nada de eso, se asume que el nombre del negocio está en el
// membrete/encabezado (primera línea con texto real de la foto). Es la
// extracción menos confiable de las cuatro — conviene revisarla siempre.
function extraerBeneficiarioComprobante(texto) {
  if (!texto) return "";
  const limpio = texto.replace(/\r/g, "");

  const destino = extraerLineaCercaDeEtiqueta(
    limpio,
    /cuenta\s*(?:de\s*)?destino/i,
    /cuenta\s*(?:de\s*)?destino[:\-\s]{0,5}([A-Za-zÀ-ÿ0-9.,&'\- ]{3,60})/i
  );
  if (destino) return destino;

  const patronesVendedor = [
    /(?:proveedor|vendedor|emisor|destinatario)[:\-\s]{0,5}([A-Za-zÀ-ÿ0-9.,&'\- ]{3,60})/i,
    /raz[oó]n\s*social\s*(?:del?\s*(?:emisor|proveedor|vendedor))[:\-\s]{0,5}([A-Za-zÀ-ÿ0-9.,&'\- ]{3,60})/i
  ];
  for (const re of patronesVendedor) {
    const m = limpio.match(re);
    if (m) {
      const nombre = limpiarNombreOCR(m[1]);
      if (nombre) return nombre;
    }
  }
  // Sin campo explícito: se asume que el nombre del negocio está en el
  // encabezado (primera línea de la foto que parece un nombre real).
  const lineas = limpio.split("\n").map(l => l.trim());
  const primeraLinea = lineas.find(esNombrePosible);
  if (primeraLinea) return limpiarNombreOCR(primeraLinea);
  return "";
}

// Quita tildes y pasa a minúsculas, para poder comparar nombres de cuenta sin
// que un acento rompa la coincidencia (ej. "Banco Unión" vs "Banco Union").
function normalizarTextoComparacion(s) {
  // Rango Unicode de "marcas diacríticas combinantes" (tildes, diéresis, etc.)
  // armado con códigos numéricos a propósito, para evitar problemas de
  // codificación al escribir el caracter combinante literal en el archivo.
  const desde = String.fromCharCode(768);  // U+0300
  const hasta = String.fromCharCode(879);  // U+036F
  const combinantes = new RegExp("[" + desde + "-" + hasta + "]", "g");
  return (s || "").normalize("NFD").replace(combinantes, "").toLowerCase().trim();
}

// Devuelve el bloque de texto que sigue a una etiqueta (el resto de esa misma
// línea + hasta maxLineas líneas siguientes, concatenadas). A diferencia de
// extraerLineaCercaDeEtiqueta, acá no se corta en la primera línea que "no
// parece nombre" — sirve para datos que pueden venir repartidos en varias
// líneas (ej. banco en una línea, número de cuenta en la siguiente).
function extraerBloqueCercaDeEtiqueta(texto, etiquetaRegex, maxLineas = 3) {
  const lineas = texto.split("\n").map(l => l.trim());
  for (let i = 0; i < lineas.length; i++) {
    if (!etiquetaRegex.test(lineas[i])) continue;
    const resto = lineas[i].replace(etiquetaRegex, "").trim();
    const siguientes = lineas.slice(i + 1, i + 1 + maxLineas).filter(Boolean);
    return [resto, ...siguientes].filter(Boolean).join(" ");
  }
  return "";
}

// Deja solo los dígitos de un string — para comparar números de cuenta sin
// que separadores (espacios, guiones, "CA", etc.) rompan la comparación.
function soloDigitos(s) {
  return (s || "").replace(/\D/g, "");
}

// Busca, dentro de un bloque de texto (normalmente el que sigue a "Cuenta de
// origen" en un comprobante de transferencia), el nombre de alguna cuenta que
// el usuario ya tiene configurada (STATE.cuentas) — para autoseleccionar el
// select "Cuenta" del formulario en vez de dejarlo vacío. La comparación es
// sin tildes/mayúsculas y en ambos sentidos (el nombre configurado puede ser
// más corto o más largo que lo que dice el comprobante, ej. "Banco Unión" vs
// "Banco Unión Cta. Ahorro 123456").
function matchCuentaConfigurada(bloque) {
  if (!bloque || !STATE.cuentas || !STATE.cuentas.length) return "";
  const norm = normalizarTextoComparacion(bloque);

  // Prioridad más alta: el NÚMERO DE CUENTA (5+ dígitos seguidos en el
  // comprobante) aparece dentro del nombre configurado de la cuenta — ej. el
  // usuario configuró la cuenta como "Banco Ganadero CA 1311257972". Un
  // número de cuenta es mucho más preciso que el nombre del banco solo,
  // sobre todo si el usuario tiene más de una cuenta en el mismo banco.
  const numerosBloque = bloque.match(/\d{5,}/g) || [];
  if (numerosBloque.length) {
    for (const numero of numerosBloque) {
      for (const c of STATE.cuentas) {
        if (soloDigitos(c.nombre).includes(numero)) return c.nombre;
      }
    }
  }

  // Se juntan TODOS los candidatos que matchean (no el primero que aparece en
  // la lista) y se elige el más específico (nombre más largo). Esto evita que
  // una cuenta configurada de forma genérica (ej. solo "Banco") le gane a una
  // más específica que también está configurada (ej. "Banco Unión") nada más
  // que por venir antes en la lista — "Banco" sería substring de casi
  // cualquier nombre de banco real.
  const candidatos = [];
  for (const c of STATE.cuentas) {
    const nombreNorm = normalizarTextoComparacion(c.nombre);
    if (nombreNorm.length >= 3 && (norm.includes(nombreNorm) || nombreNorm.includes(norm))) {
      candidatos.push({ nombre: c.nombre, score: nombreNorm.length });
    }
  }
  if (candidatos.length) {
    candidatos.sort((a, b) => b.score - a.score);
    return candidatos[0].nombre;
  }
  // Pasada más flexible (solo si la anterior no encontró nada): todas las
  // palabras del nombre configurado aparecen en el bloque sin importar el
  // orden (ej. "Efectivo en caja" en la foto matchea con la cuenta
  // configurada "Caja Efectivo"). Requiere 2+ palabras significativas para no
  // activarse con nombres de una sola palabra demasiado genéricos (ej. sería
  // fácil que "Banco" a secas aparezca en cualquier texto de transferencia).
  for (const c of STATE.cuentas) {
    const palabras = normalizarTextoComparacion(c.nombre).split(/\s+/).filter(p => p.length >= 3);
    if (palabras.length >= 2 && palabras.every(p => norm.includes(p))) {
      candidatos.push({ nombre: c.nombre, score: palabras.join(" ").length });
    }
  }
  if (candidatos.length) {
    candidatos.sort((a, b) => b.score - a.score);
    return candidatos[0].nombre;
  }
  return "";
}

// Busca la cuenta de origen del pago (de dónde salió la plata) en un
// comprobante de transferencia bancaria/QR y trata de matchearla contra las
// cuentas que el usuario ya tiene configuradas en la app (Configuración →
// Cuentas). Si no encuentra ninguna coincidencia, no inventa nada: deja el
// select vacío para que el usuario lo elija a mano.
function extraerCuentaOrigenComprobante(texto) {
  if (!texto) return "";
  const limpio = texto.replace(/\r/g, "");
  const bloque = extraerBloqueCercaDeEtiqueta(limpio, /cuenta\s*(?:de\s*)?origen/i);
  if (!bloque) return "";
  return matchCuentaConfigurada(bloque);
}

// Corre el OCR UNA sola vez sobre la foto y completa los campos que estén
// vacíos (o, en el caso de la fecha, que sigan en su valor por defecto):
// numeroInput (Nº de comprobante), montoInput (monto gastado), fechaInput
// (fecha del comprobante), beneficiarioInput (a quién se le pagó) y
// cuentaSelect (de qué cuenta propia salió la plata, matcheada contra
// STATE.cuentas). Nunca pisa un valor que el usuario ya haya escrito a mano.
// statusEl (opcional) muestra el progreso y el resultado, con el texto crudo
// del OCR desplegable para poder reportar lecturas fallidas.
async function autoRellenarDesdeComprobante(dataUrl, { numeroInput, montoInput, fechaInput, beneficiarioInput, cuentaSelect, statusEl } = {}) {
  const necesitaNumero = !!(numeroInput && !numeroInput.value.trim());
  const necesitaMonto = !!(montoInput && !montoInput.value.trim());
  const necesitaFecha = fechaEsAutocompletable(fechaInput);
  const necesitaBeneficiario = !!(beneficiarioInput && !beneficiarioInput.value.trim());
  const necesitaCuenta = !!(cuentaSelect && !cuentaSelect.value);
  if (!necesitaNumero && !necesitaMonto && !necesitaFecha && !necesitaBeneficiario && !necesitaCuenta) return;
  if (statusEl) statusEl.textContent = "🔎 Leyendo comprobante…";
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(dataUrl);
    console.debug("[OCR comprobante] texto reconocido:", data.text);
    const detectados = [];
    const faltantes = [];
    if (necesitaNumero) {
      const numero = extraerNumeroComprobante(data.text);
      if (numero && !numeroInput.value.trim()) {
        numeroInput.value = numero;
        flashOcrFilled(numeroInput);
        detectados.push(`Nº ${numero}`);
      } else {
        faltantes.push("número");
      }
    }
    if (necesitaMonto) {
      const monto = extraerMontoComprobante(data.text);
      if (monto != null && !montoInput.value.trim()) {
        montoInput.value = monto.toFixed(2);
        flashOcrFilled(montoInput);
        montoInput.dispatchEvent(new Event("input", { bubbles: true }));
        detectados.push(`Bs ${monto.toFixed(2)}`);
      } else {
        faltantes.push("monto");
      }
    }
    if (necesitaFecha) {
      const fecha = extraerFechaComprobante(data.text);
      if (fecha && fechaEsAutocompletable(fechaInput)) {
        fechaInput.value = fecha;
        flashOcrFilled(fechaInput);
        fechaInput.dispatchEvent(new Event("input", { bubbles: true }));
        fechaInput.dispatchEvent(new Event("change", { bubbles: true }));
        detectados.push(fmtDate(fecha));
      } else {
        faltantes.push("fecha");
      }
    }
    if (necesitaBeneficiario) {
      const nombre = extraerBeneficiarioComprobante(data.text);
      if (nombre && !beneficiarioInput.value.trim()) {
        beneficiarioInput.value = nombre;
        flashOcrFilled(beneficiarioInput);
        detectados.push(`"${nombre}"`);
      } else {
        faltantes.push("beneficiario");
      }
    }
    if (necesitaCuenta) {
      const cuenta = extraerCuentaOrigenComprobante(data.text);
      if (cuenta && !cuentaSelect.value) {
        cuentaSelect.value = cuenta;
        flashOcrFilled(cuentaSelect);
        cuentaSelect.dispatchEvent(new Event("change", { bubbles: true }));
        detectados.push(`Cuenta: ${cuenta}`);
      } else {
        faltantes.push("cuenta de origen");
      }
    }
    if (statusEl) {
      const okMsg = detectados.length ? `✅ Detectado: ${detectados.join(" · ")} (revisá, sobre todo el beneficiario)` : "";
      const faltaMsg = faltantes.length ? `⚠️ No se pudo leer ${faltantes.join(", ")} — cargalo a mano.` : "";
      const resumen = [okMsg, faltaMsg].filter(Boolean).join(" ") || "No se pudo leer nada del comprobante automáticamente — cargalo a mano.";
      // Se deja el texto crudo del OCR desplegable: si algo no se lee bien,
      // el usuario puede copiarlo y pasarlo para ajustar la lectura.
      statusEl.innerHTML = `<div>${escapeHtml(resumen)}</div>` +
        `<details class="ocr-debug"><summary>Ver texto que leyó el OCR</summary><pre>${escapeHtml(data.text || "(vacío)")}</pre></details>`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "No se pudo leer el comprobante automáticamente — cargalo a mano.";
  }
}

/* ==========================================================================
   OCR de FACTURA/RECIBO DE COMPRA (distinto del comprobante de pago): esta
   segunda foto es la que lista el/los producto(s) comprados — se usa para
   reconocer QUÉ producto es (matcheando contra el catálogo de Almacén ya
   cargado, nunca inventando un nombre nuevo) y, si se puede, cantidad/unidad
   y precio/monto. Mismo principio que el resto del OCR: nunca pisa un campo
   que el usuario ya haya completado a mano.
   ========================================================================== */

// Busca, dentro del texto del OCR de una factura/recibo de compra, algún
// producto que el usuario YA tenga cargado en el catálogo de Almacén
// (STATE.almacenProductos) — opcionalmente filtrado por categoría(s), para
// no confundir "Vacuna Aftosa" con "Arroz" si se sabe que la compra es de
// Sanidad. Igual que matchCuentaConfigurada: nunca inventa un producto que
// no exista en el catálogo, y si hay varios candidatos se queda con el
// nombre más largo/específico.
function extraerProductoComprobante(texto, categorias) {
  if (!texto || !STATE.almacenProductos || !STATE.almacenProductos.length) return null;
  const norm = normalizarTextoComparacion(texto);
  const candidatos = [];
  STATE.almacenProductos.forEach(p => {
    if (categorias && categorias.length && !categorias.includes(p.categoria)) return;
    const nombreNorm = normalizarTextoComparacion(p.nombre);
    if (nombreNorm.length >= 3 && norm.includes(nombreNorm)) {
      candidatos.push({ producto: p, score: nombreNorm.length });
    }
  });
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b.score - a.score);
  return candidatos[0].producto;
}

// Corre el OCR sobre la foto de la factura/recibo de compra y completa los
// campos que estén vacíos: `productoField` (un <input> de texto libre, ej.
// "Producto/Detalle", o un <select> como el de Adelantos y Víveres — se
// detecta el tipo de elemento solo), `cantidadInput`/`unidadInput` (vía el
// mismo detector que ya usa "Detectar cantidades automáticamente" en
// Almacén), y `montoInput`/`precioInput` (vía el mismo detector de montos
// que el comprobante de pago). `categorias` (array opcional) filtra contra
// qué categorías de Almacén se busca el producto.
async function autoRellenarProductoDesdeFactura(dataUrl, { productoField, categorias, cantidadInput, unidadInput, precioInput, montoInput, statusEl } = {}) {
  const esSelect = productoField && productoField.tagName === "SELECT";
  const necesitaProducto = !!(productoField && (esSelect ? !productoField.value : !productoField.value.trim()));
  const necesitaCantidad = !!(cantidadInput && !cantidadInput.value.trim());
  const necesitaPrecio = !!(precioInput && !precioInput.value.trim());
  const necesitaMonto = !!(montoInput && !montoInput.value.trim());
  if (!necesitaProducto && !necesitaCantidad && !necesitaPrecio && !necesitaMonto) return;
  if (statusEl) statusEl.textContent = "🔎 Leyendo factura/recibo…";
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(dataUrl);
    console.debug("[OCR factura] texto reconocido:", data.text);
    const detectados = [];
    const faltantes = [];

    if (necesitaProducto) {
      const producto = extraerProductoComprobante(data.text, categorias);
      if (producto) {
        if (esSelect) {
          const opt = Array.from(productoField.options).find(o => o.value === producto.id);
          if (opt) {
            productoField.value = producto.id;
            productoField.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else {
          productoField.value = producto.nombre;
        }
        flashOcrFilled(productoField);
        detectados.push(`Producto: ${producto.nombre}`);
      } else {
        faltantes.push("producto (no reconocí ninguno de tu catálogo — cargalo a mano)");
      }
    }

    if (necesitaCantidad) {
      const det = detectarCantidadUnidad(data.text);
      if (det) {
        cantidadInput.value = det.cantidad;
        flashOcrFilled(cantidadInput);
        cantidadInput.dispatchEvent(new Event("input", { bubbles: true }));
        if (unidadInput && !unidadInput.value.trim()) { unidadInput.value = det.unidad; flashOcrFilled(unidadInput); }
        detectados.push(`Cantidad: ${det.cantidad} ${det.unidad}`);
      } else {
        faltantes.push("cantidad");
      }
    }

    if (necesitaMonto || necesitaPrecio) {
      const monto = extraerMontoComprobante(data.text);
      if (monto != null) {
        if (necesitaMonto) {
          montoInput.value = monto.toFixed(2);
          flashOcrFilled(montoInput);
          montoInput.dispatchEvent(new Event("input", { bubbles: true }));
          detectados.push(`Monto: Bs ${monto.toFixed(2)}`);
        } else if (necesitaPrecio && cantidadInput && Number(cantidadInput.value) > 0) {
          precioInput.value = (monto / Number(cantidadInput.value)).toFixed(2);
          flashOcrFilled(precioInput);
          precioInput.dispatchEvent(new Event("input", { bubbles: true }));
          detectados.push(`Precio unit.: Bs ${precioInput.value}`);
        }
      } else if (necesitaMonto) {
        faltantes.push("monto");
      }
    }

    if (statusEl) {
      const okMsg = detectados.length ? `✅ Detectado: ${detectados.join(" · ")} (revisá antes de guardar)` : "";
      const faltaMsg = faltantes.length ? `⚠️ No se pudo leer ${faltantes.join(", ")} — cargalo a mano.` : "";
      const resumen = [okMsg, faltaMsg].filter(Boolean).join(" ") || "No se pudo leer nada de la factura automáticamente — cargalo a mano.";
      statusEl.innerHTML = `<div>${escapeHtml(resumen)}</div>` +
        `<details class="ocr-debug"><summary>Ver texto que leyó el OCR</summary><pre>${escapeHtml(data.text || "(vacío)")}</pre></details>`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "No se pudo leer la factura automáticamente — cargala a mano.";
  }
}

/* ==========================================================================
   Detección de comprobantes repetidos: si el Nº de comprobante que se va a
   guardar ya existe en la misma colección, se avisa antes de guardar (en vez
   de guardar en silencio un posible gasto/movimiento duplicado, ej. por subir
   la misma foto dos veces sin darse cuenta).
   ========================================================================== */

// Busca en `coleccion` (nombre de la colección en STATE, ej. "diario") una
// fila que ya tenga el mismo Nº de comprobante (comparación sin mayúsculas ni
// espacios de más). excludeId sirve para no comparar una fila contra sí
// misma al editarla. Números de comprobante vacíos nunca se consideran
// duplicados (muchos gastos no tienen comprobante con número).
function buscarComprobanteDuplicado(coleccion, numeroComprobante, excludeId) {
  const n = (numeroComprobante || "").trim().toLowerCase();
  if (!n) return null;
  return (STATE[coleccion] || []).find(r =>
    r.id !== excludeId && (r.numeroComprobante || "").trim().toLowerCase() === n
  ) || null;
}

// Arma una descripción corta y legible de la fila duplicada encontrada, para
// mostrarla en el aviso de confirmación.
function describirFilaDuplicada(row) {
  const partes = [fmtDate(row.fecha)];
  if (row.categoria) partes.push(row.categoria);
  const detalle = row.subcategoria || row.descripcion || row.concepto;
  if (detalle) partes.push(detalle);
  if (row.monto != null && row.monto !== "") partes.push(`Bs ${fmtMoney2(row.monto)}`);
  return partes.join(" · ");
}

// Si el Nº de comprobante ya existe en `coleccion`, muestra un aviso y pide
// confirmación antes de seguir. Devuelve true si está bien continuar
// guardando (no había duplicado, o el usuario confirmó igual de todos
// modos), false si hay que cancelar el guardado.
function confirmarSiNoEsDuplicado(coleccion, numeroComprobante, excludeId) {
  const dup = buscarComprobanteDuplicado(coleccion, numeroComprobante, excludeId);
  if (!dup) return true;
  return confirm(
    `⚠️ Ya hay un movimiento cargado con el Nº de comprobante "${numeroComprobante}":\n` +
    `${describirFilaDuplicada(dup)}\n\n` +
    `¿Seguro que querés cargar este comprobante de nuevo?`
  );
}

/* ==========================================================================
   Tabla CRUD genérica
   ========================================================================== */
function mountCrudTable(container, cfg) {
  // cfg: { collection, columns[], data?(), onAfterChange, footer?(rows), rowClass?(row), emptyText, sortFn? }
  const getData = () => (cfg.data ? cfg.data() : STATE[cfg.collection]);

  function fieldHtml(col, value, rowContext) {
    const id = `f_${col.key}`;
    const val = value == null ? "" : value;
    if (col.type === "select") {
      const opts = resolveOptions(col.options);
      const isObj = opts.length && typeof opts[0] === "object";
      return `<select id="${id}" data-key="${col.key}" ${col.required ? "required" : ""}>
        <option value=""></option>
        ${opts.map(o => {
          const v = isObj ? o.value : o;
          const l = isObj ? o.label : o;
          return `<option value="${escapeHtml(v)}" ${String(v)===String(val)?"selected":""}>${escapeHtml(l)}</option>`;
        }).join("")}
      </select>`;
    }
    if (col.type === "textarea") {
      return `<textarea id="${id}" data-key="${col.key}">${escapeHtml(val)}</textarea>`;
    }
    if (col.type === "textlist") {
      const dlId = `${id}_dl`;
      const opts = col.optionsFor ? col.optionsFor(rowContext || {}) : resolveOptions(col.options || []);
      return `<input id="${id}" data-key="${col.key}" data-dl="${dlId}" type="text" list="${dlId}" value="${escapeHtml(val)}" placeholder="${escapeHtml(col.placeholder||"")}">
        <datalist id="${dlId}">${opts.map(o => `<option value="${escapeHtml(o)}">`).join("")}</datalist>`;
    }
    if (col.type === "image") {
      return `
        <input type="hidden" id="${id}" data-key="${col.key}" value="${escapeHtml(val)}">
        <input type="file" id="${id}_file" accept="image/*" capture="environment">
        <div id="${id}_preview" class="img-preview-wrap">
          ${val ? `<img src="${val}" class="img-preview"><button type="button" class="btn secondary small" data-clear-img="${id}">Quitar</button>` : ""}
        </div>`;
    }
    const step = col.step || (col.type === "number" ? "any" : undefined);
    return `<input id="${id}" data-key="${col.key}" type="${col.type || "text"}" ${step ? `step="${step}"` : ""} value="${escapeHtml(val)}" ${col.required ? "required" : ""}>`;
  }

  function formHtml(editingRow) {
    const rowContext = editingRow || {};
    return `
      <div class="card form-card">
        ${editingRow ? `<span class="badge-editing">✏️ Editando fila</span>` : ""}
        <form id="crudForm" autocomplete="off">
          <div class="form-grid">
            ${cfg.columns.map(col => `
              <div class="field">
                <label>${col.label}${col.required ? " *" : ""}</label>
                ${fieldHtml(col, editingRow ? editingRow[col.key] : (col.default != null ? col.default : ""), rowContext)}
              </div>`).join("")}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn">${editingRow ? "Guardar cambios" : "➕ Agregar"}</button>
            ${editingRow ? `<button type="button" class="btn secondary" id="cancelEdit">Cancelar</button>` : ""}
          </div>
        </form>
      </div>`;
  }

  function tableHtml(rows) {
    if (!rows.length) {
      return `<div class="empty-state">${cfg.emptyText || "Todavía no cargaste ningún dato acá."}</div>`;
    }
    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            ${cfg.columns.map(c => `<th>${c.label}</th>`).join("")}
            ${cfg.extraColumns ? cfg.extraColumns.map(c => `<th>${c.label}</th>`).join("") : ""}
            <th>Acciones</th>
          </tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr data-id="${row.id}">
                ${cfg.columns.map(c => `<td class="${c.numeric ? "num":""}">${
                  c.type === "image"
                    ? (row[c.key] ? `<img src="${row[c.key]}" class="img-thumb lightbox-trigger" alt="Comprobante" title="Ver comprobante">` : "—")
                    : c.type === "date"
                      ? fmtDate(row[c.key])
                      : (cfg.formatCell ? cfg.formatCell(row, c) : escapeHtml(row[c.key]))
                }</td>`).join("")}
                ${cfg.extraColumns ? cfg.extraColumns.map(c => `<td class="${c.numeric?"num":""}">${c.render(row)}</td>`).join("") : ""}
                <td class="row-actions">
                  <button data-action="edit" data-id="${row.id}">Editar</button>
                  <button data-action="delete" data-id="${row.id}" class="danger">Eliminar</button>
                </td>
              </tr>`).join("")}
          </tbody>
          ${cfg.footer ? `<tfoot>${cfg.footer(rows)}</tfoot>` : ""}
        </table>
      </div>`;
  }

  let editingId = null;

  function paint() {
    const rows = cfg.sortFn ? getData().slice().sort(cfg.sortFn) : getData();
    const editingRow = editingId ? getData().find(r => r.id === editingId) : null;
    // noAddForm: la tabla no ofrece su propio formulario para agregar filas nuevas
    // (se usa cuando ya existe otro formulario dedicado en la pantalla, para no duplicar la carga).
    const showForm = editingRow || !cfg.noAddForm;
    container.innerHTML = (showForm ? formHtml(editingRow) : "") + tableHtml(rows);
    wire();
  }

  function readForm() {
    const values = {};
    cfg.columns.forEach(col => {
      const elm = container.querySelector(`#f_${col.key}`);
      let v = elm.value;
      if (col.type === "number") v = v === "" ? 0 : Number(v);
      values[col.key] = v;
    });
    if (cfg.fixedValues) Object.assign(values, resolveOptions(cfg.fixedValues));
    return values;
  }

  function wire() {
    const form = container.querySelector("#crudForm");
    if (form) form.addEventListener("submit", e => {
      e.preventDefault();
      const values = readForm();
      if (editingId) {
        crudUpdate(cfg.collection, editingId, values);
        editingId = null;
      } else {
        crudAdd(cfg.collection, values);
      }
      if (cfg.onAfterChange) cfg.onAfterChange(); else paint();
    });
    const cancelBtn = container.querySelector("#cancelEdit");
    if (cancelBtn) cancelBtn.addEventListener("click", () => { editingId = null; paint(); });

    // Autocompletado dependiente: si una columna "textlist" depende de otra (dependsOn),
    // al cambiar esa otra columna se refrescan las sugerencias del datalist.
    cfg.columns.forEach(col => {
      if (col.type !== "textlist" || !col.dependsOn || !col.optionsFor) return;
      const depElm = container.querySelector(`#f_${col.dependsOn}`);
      const thisElm = container.querySelector(`#f_${col.key}`);
      if (!depElm || !thisElm) return;
      const dl = container.querySelector(`#${thisElm.dataset.dl}`);
      if (!dl) return;
      depElm.addEventListener("change", () => {
        const opts = col.optionsFor({ [col.dependsOn]: depElm.value });
        dl.innerHTML = opts.map(o => `<option value="${escapeHtml(o)}">`).join("");
      });
    });

    container.querySelectorAll('button[data-action="edit"]').forEach(btn => {
      btn.addEventListener("click", () => { editingId = btn.dataset.id; paint(); window.scrollTo({top:0,behavior:"smooth"}); });
    });
    container.querySelectorAll('button[data-action="delete"]').forEach(btn => {
      btn.addEventListener("click", () => {
        if (!confirm("¿Eliminar esta fila?")) return;
        crudDelete(cfg.collection, btn.dataset.id);
        if (cfg.onAfterChange) cfg.onAfterChange(); else paint();
      });
    });

    // Columnas tipo "image" (comprobantes): al elegir un archivo se comprime y
    // se guarda como base64 en el input oculto; un botón "Quitar" lo borra.
    function wireClearImgButtons() {
      container.querySelectorAll("[data-clear-img]").forEach(btn => {
        btn.onclick = () => {
          const hiddenId = btn.dataset.clearImg;
          const hidden = container.querySelector(`#${hiddenId}`);
          if (hidden) hidden.value = "";
          const prev = container.querySelector(`#${hiddenId}_preview`);
          if (prev) prev.innerHTML = "";
        };
      });
    }
    cfg.columns.forEach(col => {
      if (col.type !== "image") return;
      const hiddenId = `f_${col.key}`;
      const fileInput = container.querySelector(`#${hiddenId}_file`);
      if (!fileInput) return;
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
          const dataUrl = await fileToCompressedDataURL(file);
          const hidden = container.querySelector(`#${hiddenId}`);
          if (hidden) hidden.value = dataUrl;
          const prev = container.querySelector(`#${hiddenId}_preview`);
          if (prev) prev.innerHTML = `<img src="${dataUrl}" class="img-preview"><button type="button" class="btn secondary small" data-clear-img="${hiddenId}">Quitar</button>`;
          wireClearImgButtons();
          const colKeys = cfg.columns.map(c => c.key);
          if (col.key === "facturaCompra") {
            // Esta es la factura/recibo de compra (distinta del comprobante de
            // pago): intenta reconocer el producto (contra el catálogo de
            // Almacén) y, si se puede, cantidad/unidad/precio — nunca pisa un
            // valor ya escrito a mano.
            if (colKeys.includes("subcategoria") || colKeys.includes("productoId") || colKeys.includes("cantidad")) {
              autoRellenarProductoDesdeFactura(dataUrl, {
                productoField: container.querySelector("#f_subcategoria") || container.querySelector("#f_productoId"),
                cantidadInput: container.querySelector("#f_cantidad"),
                unidadInput: container.querySelector("#f_unidad"),
                precioInput: container.querySelector("#f_precioUnitario"),
                montoInput: container.querySelector("#f_monto") || container.querySelector("#f_total")
              });
            }
          } else if (colKeys.includes("numeroComprobante") || colKeys.includes("monto") || colKeys.includes("beneficiario") || colKeys.includes("cuenta")) {
            // Comprobante de pago: intenta leer número/monto/beneficiario/cuenta.
            // La fecha se deja afuera a propósito: al editar una fila existente
            // esa fecha ya es la fecha real histórica del movimiento, no un
            // placeholder de "hoy" — no correspondería tocarla acá.
            autoRellenarDesdeComprobante(dataUrl, {
              numeroInput: container.querySelector("#f_numeroComprobante"),
              montoInput: container.querySelector("#f_monto"),
              beneficiarioInput: container.querySelector("#f_beneficiario"),
              cuentaSelect: container.querySelector("#f_cuenta")
            });
          }
        } catch (err) {
          alert("No se pudo procesar la imagen: " + err.message);
        }
      });
    });
    wireClearImgButtons();
  }

  paint();
}

/* ==========================================================================
   INICIO / DASHBOARD
   ========================================================================== */
function renderInicio(root) {
  const d = calcDashboard(STATE);
  const er = calcEstadoResultado(STATE, STATE.meta.anio);
  const inv = calcGanadoInventario(STATE);

  root.innerHTML = `
    <div class="note">👋 Cargá cada gasto o ingreso en <b>Diario</b>, y las compras/ventas/nacimientos/muertes en <b>Ganado</b>. Todo lo demás (resultados, caja, rentabilidad) se calcula solo.</div>

    <div class="section">
      <div class="grid cols-4">
        <div class="card kpi">
          <span class="kpi-label">💰 ¿Soy rentable? (año ${d.anio})</span>
          <span class="kpi-value ${d.resultado>=0?'pos':'neg'}">${fmtMoney(d.resultado)}</span>
          <span class="kpi-sub">${d.estado === 'RENTABLE' ? '✔ Rentable' : d.estado === 'PÉRDIDA' ? '✖ Pérdida' : 'Equilibrio'}</span>
        </div>
        <div class="card kpi">
          <span class="kpi-label">💵 Plata disponible (caja+banco)</span>
          <span class="kpi-value ${d.caja>=0?'pos':'neg'}">${fmtMoney(d.caja)}</span>
          <span class="kpi-sub">Saldo acumulado a diciembre</span>
        </div>
        <div class="card kpi">
          <span class="kpi-label">🐂 Valor del rodeo</span>
          <span class="kpi-value">${fmtMoney(d.valorRodeo)}</span>
          <span class="kpi-sub">${fmtNum(d.cabezasTotales)} cabezas totales</span>
        </div>
        <div class="card kpi">
          <span class="kpi-label">📈 Margen neto %</span>
          <span class="kpi-value ${d.margenNeto>=0?'pos':'neg'}">${fmtPct(d.margenNeto)}</span>
          <span class="kpi-sub">Carga animal: ${fmtNum(d.cargaAnimal)} EV/ha</span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Alertas</div>
      ${d.alertas.map(a => `<div class="alert ${a.level==='ok'?'ok':a.level==='warn'?'warn':'bad'}">${a.text}</div>`).join("")}
    </div>

    <div class="section grid cols-2">
      <div class="chart-card"><b>Ingresos vs. Costos por mes</b><canvas id="chDashIE"></canvas></div>
      <div class="chart-card"><b>Composición del rodeo</b><canvas id="chDashRodeo"></canvas></div>
    </div>

    <div class="section">
      <div class="section-title">Accesos rápidos</div>
      <div class="grid cols-4">
        <a class="btn secondary" href="#/diario">📝 Cargar gasto/ingreso</a>
        <a class="btn secondary" href="#/ganado">🐂 Cargar movimiento de ganado</a>
        <a class="btn secondary" href="#/financiero">📊 Ver estados financieros</a>
        <a class="btn secondary" href="#/analisis">📈 Ver análisis</a>
      </div>
    </div>
  `;
  chartLineIngresosEgresos("chDashIE", er);
  chartRodeoPorCategoria("chDashRodeo", inv);
}

/* ==========================================================================
   DIARIO
   ========================================================================== */
function renderDiario(root) {
  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="general">Gastos e Ingresos</button>
      <button class="tab-btn" data-tab="compra-multiple">Compra con varios productos</button>
      <button class="tab-btn" data-tab="personal">Adelantos y Víveres a Trabajadores</button>
    </div>
    <div id="diarioContent"></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => {
    if (b.dataset.tab === uiState.diarioTab) b.classList.add("active");
    b.addEventListener("click", () => { uiState.diarioTab = b.dataset.tab; renderDiario(root); });
  });
  const content = root.querySelector("#diarioContent");

  if (uiState.diarioTab === "personal") {
    renderDiarioPersonal(content, root);
    return;
  }
  if (uiState.diarioTab === "compra-multiple") {
    renderDiarioCompraMultiple(content, root);
    return;
  }

  const hoy = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <div class="note">Registrá acá cada gasto (EGRESO) o ingreso (INGRESO) que no sea compra/venta de ganado (eso va en la pestaña <b>Ganado</b>) ni adelantos/víveres a trabajadores (eso va en la pestaña <b>Adelantos y Víveres a Trabajadores</b>). El campo <b>Producto / Detalle</b> recuerda solo lo que vas escribiendo por categoría (ej. en Víveres: arroz, aceite, carne…), así la próxima carga es más rápida. Si la categoría es <b>Víveres, Accesorios, Sanidad, Nutrición o Combustible</b>, aparecen los campos <b>Cantidad</b>, <b>Unidad</b> (kilos, litros, unidad, dosis…) y <b>Precio unitario</b>: al cargarlos, el gasto además suma stock automáticamente en <b>Almacén</b> (el producto se crea solo la primera vez). El <b>Comprobante</b> es opcional. Si más adelante necesitás corregir la cantidad de algo que ya cargaste, lo editás en la tabla de abajo y el stock de Almacén se actualiza solo, al instante.</div>
    <div class="card form-card">
      <form id="diarioQuickForm" autocomplete="off">
        <div class="form-grid">
          <div class="field"><label>Fecha *</label><input type="date" id="dqFecha" required value="${hoy}"></div>
          <div class="field"><label>Tipo *</label>
            <select id="dqTipo" required>
              <option value="EGRESO">EGRESO</option>
              <option value="INGRESO">INGRESO</option>
            </select>
          </div>
          <div class="field"><label>Categoría *</label>
            <select id="dqCategoria" required>
              <option value=""></option>
              ${STATE.categoriasDiario.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Producto / Detalle</label>
            <input id="dqSubcategoria" type="text" list="dqSubcategoriaList" placeholder="Ej: Arroz, Aceite, Carne…">
            <datalist id="dqSubcategoriaList"></datalist>
          </div>
          <div class="field" id="dqCantidadField" style="display:none"><label>Cantidad</label><input type="number" step="0.01" id="dqCantidad"></div>
          <div class="field" id="dqUnidadField" style="display:none"><label>Unidad</label>
            <input id="dqUnidad" type="text" list="dqUnidadList" placeholder="Kilos, Litros…">
            <datalist id="dqUnidadList">
              <option value="Kilos"><option value="Litros"><option value="Unidad"><option value="Dosis"><option value="Bolsa">
            </datalist>
          </div>
          <div class="field" id="dqPrecioField" style="display:none"><label>Precio unitario (Bs)</label><input type="number" step="0.01" id="dqPrecio"></div>
          <div class="field" id="dqPrecioVentaField" style="display:none"><label>Precio de venta al trabajador (este lote)</label><input type="number" step="0.01" id="dqPrecioVenta" placeholder="Si lo dejás vacío, usa el precio por defecto del producto"></div>
          <div class="field"><label>Descripción</label><input id="dqDescripcion" type="text"></div>
          <div class="field"><label>Cuenta</label>
            <select id="dqCuenta">
              <option value=""></option>
              ${STATE.cuentas.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Monto (Bs) *</label><input type="number" step="0.01" id="dqMonto" required></div>
          <div class="field"><label>Nº de comprobante</label><input type="text" id="dqNumeroComprobante" placeholder="Ej: Factura 00123"><div id="dqOcrStatus" class="ocr-status"></div></div>
          <div class="field"><label>Beneficiario / A quién fue el pago</label><input type="text" id="dqBeneficiario" placeholder="Nombre del proveedor o persona"></div>
          <div class="field"><label>Comprobante de pago (opcional)</label>
            <input type="file" id="dqComprobante" accept="image/*" capture="environment">
            <div id="dqComprobantePreview" class="img-preview-wrap"></div>
          </div>
          <div class="field" id="dqFacturaField" style="display:none"><label>Factura / Recibo de compra (opcional)</label>
            <input type="file" id="dqFactura" accept="image/*" capture="environment">
            <div id="dqFacturaPreview" class="img-preview-wrap"></div>
            <div id="dqFacturaOcrStatus" class="ocr-status"></div>
          </div>
        </div>
        <div class="form-actions"><button type="submit" class="btn">➕ Agregar</button></div>
      </form>
    </div>
    <div id="diarioTableHost" style="margin-top:16px"></div>
  `;
  const host = content.querySelector("#diarioTableHost");
  const anio = STATE.meta.anio;

  const dqCategoria = content.querySelector("#dqCategoria");
  const dqSubcategoria = content.querySelector("#dqSubcategoria");
  const dqSubcategoriaList = content.querySelector("#dqSubcategoriaList");
  const dqCantidadField = content.querySelector("#dqCantidadField");
  const dqUnidadField = content.querySelector("#dqUnidadField");
  const dqPrecioField = content.querySelector("#dqPrecioField");
  const dqPrecioVentaField = content.querySelector("#dqPrecioVentaField");
  const dqFacturaField = content.querySelector("#dqFacturaField");
  const dqCantidad = content.querySelector("#dqCantidad");
  const dqUnidad = content.querySelector("#dqUnidad");
  const dqPrecio = content.querySelector("#dqPrecio");
  const dqPrecioVenta = content.querySelector("#dqPrecioVenta");
  const dqMonto = content.querySelector("#dqMonto");

  function refrescarSubcategorias() {
    const opts = dqCategoria.value ? getSubcategorias(dqCategoria.value) : allSubcategorias();
    dqSubcategoriaList.innerHTML = opts.map(o => `<option value="${escapeHtml(o)}">`).join("");
  }
  function actualizarVisibilidadAlmacen() {
    const esAlmacen = !!DIARIO_CATEGORIA_A_ALMACEN[dqCategoria.value];
    const esVentaPersonal = ALMACEN_CATEGORIAS_VENTA_PERSONAL.includes(DIARIO_CATEGORIA_A_ALMACEN[dqCategoria.value]);
    dqCantidadField.style.display = esAlmacen ? "" : "none";
    dqUnidadField.style.display = esAlmacen ? "" : "none";
    dqPrecioField.style.display = esAlmacen ? "" : "none";
    dqPrecioVentaField.style.display = esVentaPersonal ? "" : "none";
    dqFacturaField.style.display = esAlmacen ? "" : "none";
    if (!esAlmacen) { dqCantidad.value = ""; dqUnidad.value = ""; dqPrecio.value = ""; }
    if (!esVentaPersonal) { dqPrecioVenta.value = ""; }
  }
  // Cantidad, Precio unitario y Monto (total) se recalculan entre sí: Cantidad es el ancla —
  // si cargás Cantidad + Precio unitario, el Monto se completa solo; si cargás Cantidad + Monto
  // (por ejemplo porque solo sabés el total de la factura), el Precio unitario se completa solo.
  function recalcularCamposMonto(origen) {
    const cant = Number(dqCantidad.value) || 0;
    const precio = Number(dqPrecio.value) || 0;
    const monto = Number(dqMonto.value) || 0;
    if (origen === "cantidad") {
      if (precio > 0 && cant > 0) dqMonto.value = (cant * precio).toFixed(2);
      else if (monto > 0 && cant > 0) dqPrecio.value = (monto / cant).toFixed(2);
    } else if (origen === "precio") {
      if (cant > 0) dqMonto.value = (cant * precio).toFixed(2);
    } else if (origen === "monto") {
      if (cant > 0) dqPrecio.value = (monto / cant).toFixed(2);
    }
  }
  dqCategoria.addEventListener("change", () => { refrescarSubcategorias(); actualizarVisibilidadAlmacen(); });
  dqCantidad.addEventListener("input", () => recalcularCamposMonto("cantidad"));
  dqPrecio.addEventListener("input", () => recalcularCamposMonto("precio"));
  dqMonto.addEventListener("input", () => recalcularCamposMonto("monto"));
  refrescarSubcategorias();
  actualizarVisibilidadAlmacen();

  let dqComprobanteData = "";
  content.querySelector("#dqComprobante").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = content.querySelector("#dqComprobantePreview");
    try {
      dqComprobanteData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${dqComprobanteData}" class="img-preview"><button type="button" class="btn secondary small" id="dqQuitarComprobante">Quitar</button>`;
      content.querySelector("#dqQuitarComprobante").addEventListener("click", () => {
        dqComprobanteData = "";
        preview.innerHTML = "";
        content.querySelector("#dqComprobante").value = "";
        const st = content.querySelector("#dqOcrStatus"); if (st) st.textContent = "";
      });
      autoRellenarDesdeComprobante(dqComprobanteData, {
        numeroInput: content.querySelector("#dqNumeroComprobante"),
        montoInput: content.querySelector("#dqMonto"),
        fechaInput: content.querySelector("#dqFecha"),
        beneficiarioInput: content.querySelector("#dqBeneficiario"),
        cuentaSelect: content.querySelector("#dqCuenta"),
        statusEl: content.querySelector("#dqOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  let dqFacturaData = "";
  content.querySelector("#dqFactura").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = content.querySelector("#dqFacturaPreview");
    try {
      dqFacturaData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${dqFacturaData}" class="img-preview"><button type="button" class="btn secondary small" id="dqQuitarFactura">Quitar</button>`;
      content.querySelector("#dqQuitarFactura").addEventListener("click", () => {
        dqFacturaData = "";
        preview.innerHTML = "";
        content.querySelector("#dqFactura").value = "";
        const st = content.querySelector("#dqFacturaOcrStatus"); if (st) st.textContent = "";
      });
      const almCat = DIARIO_CATEGORIA_A_ALMACEN[dqCategoria.value];
      autoRellenarProductoDesdeFactura(dqFacturaData, {
        productoField: dqSubcategoria,
        categorias: almCat ? [almCat] : null,
        cantidadInput: dqCantidad,
        unidadInput: dqUnidad,
        precioInput: dqPrecio,
        montoInput: dqMonto,
        statusEl: content.querySelector("#dqFacturaOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  content.querySelector("#diarioQuickForm").addEventListener("submit", e => {
    e.preventDefault();
    const fecha = content.querySelector("#dqFecha").value;
    const tipo = content.querySelector("#dqTipo").value;
    const categoria = dqCategoria.value;
    const subcategoria = dqSubcategoria.value.trim();
    const descripcion = content.querySelector("#dqDescripcion").value.trim();
    const cuenta = content.querySelector("#dqCuenta").value;
    const monto = Number(dqMonto.value) || 0;
    const cantidad = Number(dqCantidad.value) || 0;
    const unidad = dqUnidad.value.trim();
    const precioUnitario = Number(dqPrecio.value) || 0;
    const precioVentaLote = dqPrecioVenta.value !== "" ? Number(dqPrecioVenta.value) : undefined;
    const numeroComprobante = content.querySelector("#dqNumeroComprobante").value.trim();
    const beneficiario = content.querySelector("#dqBeneficiario").value.trim();
    if (!fecha || !categoria || !monto) { alert("Cargá al menos fecha, categoría y un monto mayor a cero."); return; }
    if (!confirmarSiNoEsDuplicado("diario", numeroComprobante)) return;

    // Al crear la fila del Diario con sus propios campos cantidad/unidad/precioUnitario,
    // db.js (crudAdd) se encarga solo de sumar el stock en Almacén si corresponde.
    crudAdd("diario", {
      fecha, tipo, categoria, subcategoria, descripcion, cuenta, monto,
      cantidad, unidad, precioUnitario, precioVentaLote,
      numeroComprobante, beneficiario,
      comprobante: dqComprobanteData, facturaCompra: dqFacturaData
    });
    renderDiario(root);
  });

  content.querySelector("#diarioTableHost").insertAdjacentHTML("beforebegin", `<div class="section-title" style="margin-top:22px">Gastos e ingresos ya cargados (editar / borrar)</div>`);
  mountCrudTable(host, {
    collection: "diario",
    noAddForm: true,
    emptyText: "Todavía no cargaste gastos ni ingresos.",
    sortFn: (a,b) => (b.fecha||"").localeCompare(a.fecha||""),
    columns: [
      { key: "fecha", label: "Fecha", type: "date", required: true },
      { key: "numeroCompra", label: "Nº de compra", type: "text", placeholder: "Agrupa varios productos de un mismo comprobante" },
      { key: "tipo", label: "Tipo", type: "select", options: ["INGRESO","EGRESO"], required: true, default: "EGRESO" },
      { key: "categoria", label: "Categoría", type: "select", options: () => STATE.categoriasDiario.map(c=>c.nombre), required: true },
      { key: "subcategoria", label: "Producto / Detalle", type: "textlist", dependsOn: "categoria", placeholder: "Ej: Arroz, Aceite, Carne…",
        optionsFor: ctx => (ctx && ctx.categoria) ? getSubcategorias(ctx.categoria) : allSubcategorias() },
      { key: "cantidad", label: "Cantidad", type: "number", step: "0.01", numeric: true },
      { key: "unidad", label: "Unidad", type: "textlist", options: ["Kilos","Litros","Unidad","Dosis","Bolsa"], placeholder: "Kilos, Litros…" },
      { key: "precioUnitario", label: "Precio unit. (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "precioVentaLote", label: "Precio venta trabajador (lote)", type: "number", step: "0.01", numeric: true },
      { key: "descripcion", label: "Descripción", type: "text" },
      { key: "cuenta", label: "Cuenta", type: "select", options: () => STATE.cuentas.map(c=>c.nombre) },
      { key: "monto", label: "Monto (Bs)", type: "number", step: "0.01", numeric: true, required: true },
      { key: "numeroComprobante", label: "Nº comprobante", type: "text" },
      { key: "beneficiario", label: "Beneficiario", type: "text" },
      { key: "comprobante", label: "Comprobante de pago", type: "image" },
      { key: "facturaCompra", label: "Factura / Recibo de compra", type: "image" }
    ],
    formatCell: (row, col) => {
      if (col.key === "tipo") return `<span class="tag ${row.tipo==='INGRESO'?'ingreso':'egreso'}">${row.tipo}</span>`;
      if (col.key === "monto" || col.key === "precioUnitario") return fmtMoney2(row[col.key]);
      return escapeHtml(row[col.key]);
    },
    footer: rows => {
      const anioRows = rows.filter(r => monthYear(r.fecha).y === anio);
      const ing = sum(anioRows.filter(r=>r.tipo==='INGRESO').map(r=>r.monto));
      const egr = sum(anioRows.filter(r=>r.tipo==='EGRESO').map(r=>r.monto));
      return `<tr><td colspan="11">Totales del año ${anio}</td><td class="num">Ingresos: ${fmtMoney2(ing)} · Egresos: ${fmtMoney2(egr)}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
    },
    onAfterChange: () => renderDiario(root)
  });
}

/* ---------------------------- DIARIO: Compra con varios productos (mismo comprobante) ---------------------------- */
function renderDiarioCompraMultiple(host, root) {
  const hoy = new Date().toISOString().slice(0, 10);
  const numeroSugerido = nextNumeroCompra();
  host.innerHTML = `
    <div class="note">Usá esto cuando compres <b>varios productos con un solo comprobante</b> (ej. el mismo recibo del vivero, la ferretería o la veterinaria). Cargá el número de compra, la fecha, el comprobante y el <b>monto total que dice el recibo</b> — después agregá una línea por cada producto. El sistema va sumando las líneas y te avisa si coincide con el total del comprobante.</div>
    <div class="card form-card">
      <div class="form-grid">
        <div class="field"><label>Número de compra</label><input type="text" id="cmNumero" value="${escapeHtml(numeroSugerido)}"></div>
        <div class="field"><label>Fecha *</label><input type="date" id="cmFecha" value="${hoy}"></div>
        <div class="field"><label>Cuenta</label>
          <select id="cmCuenta">
            <option value=""></option>
            ${STATE.cuentas.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Monto total del comprobante (Bs) *</label><input type="number" step="0.01" id="cmMontoDeclarado"></div>
        <div class="field"><label>Nº de comprobante</label><input type="text" id="cmNumeroComprobante" placeholder="Ej: Factura 00123"><div id="cmOcrStatus" class="ocr-status"></div></div>
        <div class="field"><label>Beneficiario / A quién fue el pago</label><input type="text" id="cmBeneficiario" placeholder="Nombre del proveedor o persona"></div>
        <div class="field"><label>Comprobante (se copia a todas las líneas)</label>
          <input type="file" id="cmComprobante" accept="image/*" capture="environment">
          <div id="cmComprobantePreview" class="img-preview-wrap"></div>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:18px">Productos de esta compra</div>
    <div id="cmLineasHost"></div>
    <div class="form-actions" style="margin-top:10px">
      <button type="button" class="btn secondary" id="cmAgregarLinea">➕ Agregar línea</button>
    </div>

    <div class="card tight" id="cmResumen" style="margin-top:16px"></div>
    <div class="form-actions" style="margin-top:14px">
      <button type="button" class="btn" id="cmGuardarTodo">💾 Guardar compra completa</button>
    </div>
  `;

  let cmComprobanteData = "";
  host.querySelector("#cmComprobante").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = host.querySelector("#cmComprobantePreview");
    try {
      cmComprobanteData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${cmComprobanteData}" class="img-preview"><button type="button" class="btn secondary small" id="cmQuitarComprobante">Quitar</button>`;
      host.querySelector("#cmQuitarComprobante").addEventListener("click", () => {
        cmComprobanteData = "";
        preview.innerHTML = "";
        host.querySelector("#cmComprobante").value = "";
        const st = host.querySelector("#cmOcrStatus"); if (st) st.textContent = "";
      });
      autoRellenarDesdeComprobante(cmComprobanteData, {
        numeroInput: host.querySelector("#cmNumeroComprobante"),
        montoInput: host.querySelector("#cmMontoDeclarado"),
        fechaInput: host.querySelector("#cmFecha"),
        beneficiarioInput: host.querySelector("#cmBeneficiario"),
        cuentaSelect: host.querySelector("#cmCuenta"),
        statusEl: host.querySelector("#cmOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  const lineasHost = host.querySelector("#cmLineasHost");
  let lineaSeq = 0;

  function pintarLineaHtml(id) {
    return `
      <div class="card tight linea-row" data-linea-id="${id}" style="margin-bottom:10px">
        <div class="form-grid">
          <div class="field"><label>Categoría</label>
            <select class="lnCategoria">
              <option value=""></option>
              ${STATE.categoriasDiario.filter(c=>c.tipo==="EGRESO").map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Producto / Detalle</label><input type="text" class="lnProducto" placeholder="Ej: Arroz, Machete…"></div>
          <div class="field"><label>Cantidad</label><input type="number" step="0.01" class="lnCantidad"></div>
          <div class="field"><label>Unidad</label>
            <input type="text" class="lnUnidad" list="lnUnidadList_${id}" placeholder="Kilos, Litros…">
            <datalist id="lnUnidadList_${id}"><option value="Kilos"><option value="Litros"><option value="Unidad"><option value="Dosis"><option value="Bolsa"></datalist>
          </div>
          <div class="field"><label>Precio unitario (Bs)</label><input type="number" step="0.01" class="lnPrecio"></div>
          <div class="field"><label>Monto (Bs)</label><input type="number" step="0.01" class="lnMonto"></div>
          <div class="field"><label>Precio venta trabajador (este lote)</label><input type="number" step="0.01" class="lnPrecioVenta" placeholder="Opcional — solo si es Víveres/Accesorios/Herramientas"></div>
          <div class="field"><label>Factura / recibo de este producto (opcional)</label>
            <input type="file" class="lnFacturaFile" accept="image/*" capture="environment">
            <div class="lnFacturaPreview img-preview-wrap"></div>
            <input type="hidden" class="lnFacturaData">
            <div class="lnFacturaOcrStatus ocr-status"></div>
          </div>
        </div>
        <div class="form-actions"><button type="button" class="btn secondary small lnQuitar">🗑️ Quitar línea</button></div>
      </div>`;
  }

  function actualizarResumen() {
    const lineas = lineasHost.querySelectorAll(".linea-row");
    const totalLineas = Array.from(lineas).reduce((a, l) => a + (Number(l.querySelector(".lnMonto").value) || 0), 0);
    const montoDeclarado = Number(host.querySelector("#cmMontoDeclarado").value) || 0;
    const dif = Math.round((montoDeclarado - totalLineas) * 100) / 100;
    const resumen = host.querySelector("#cmResumen");
    resumen.innerHTML = `
      <div class="form-grid" style="align-items:center">
        <div><b>Total de las líneas:</b> ${fmtMoney2(totalLineas)}</div>
        <div><b>Monto del comprobante:</b> ${fmtMoney2(montoDeclarado)}</div>
        <div style="color:${dif===0?'var(--green-700, green)':'#b5332a'}"><b>${dif===0?"✅ Coincide":`⚠️ Diferencia: ${fmtMoney2(Math.abs(dif))} ${dif>0?"(falta cargar)":"(sobra en las líneas)"}`}</b></div>
      </div>`;
  }

  function wireLinea(card) {
    const categoria = card.querySelector(".lnCategoria");
    const producto = card.querySelector(".lnProducto");
    const cantidad = card.querySelector(".lnCantidad");
    const unidad = card.querySelector(".lnUnidad");
    const precio = card.querySelector(".lnPrecio");
    const monto = card.querySelector(".lnMonto");
    function recalc(origen) {
      const c = Number(cantidad.value) || 0;
      const p = Number(precio.value) || 0;
      const m = Number(monto.value) || 0;
      if (origen === "cantidad") {
        if (p > 0 && c > 0) monto.value = (c*p).toFixed(2);
        else if (m > 0 && c > 0) precio.value = (m/c).toFixed(2);
      } else if (origen === "precio") {
        if (c > 0) monto.value = (c*p).toFixed(2);
      } else if (origen === "monto") {
        if (c > 0) precio.value = (m/c).toFixed(2);
      }
      actualizarResumen();
    }
    cantidad.addEventListener("input", () => recalc("cantidad"));
    precio.addEventListener("input", () => recalc("precio"));
    monto.addEventListener("input", () => recalc("monto"));
    card.querySelector(".lnQuitar").addEventListener("click", () => { card.remove(); actualizarResumen(); });

    // Factura/recibo de este producto en particular: OCR intenta reconocer el
    // producto (contra el catálogo de Almacén, filtrado por la categoría ya
    // elegida en esta línea) y, si puede, cantidad/unidad y precio/monto —
    // solo completa lo que esté vacío en ESTA línea.
    const facturaFile = card.querySelector(".lnFacturaFile");
    const facturaPreview = card.querySelector(".lnFacturaPreview");
    const facturaDataInput = card.querySelector(".lnFacturaData");
    const facturaStatus = card.querySelector(".lnFacturaOcrStatus");
    facturaFile.addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToCompressedDataURL(file);
        facturaDataInput.value = dataUrl;
        facturaPreview.innerHTML = `<img src="${dataUrl}" class="img-preview"><button type="button" class="btn secondary small lnQuitarFactura">Quitar</button>`;
        facturaPreview.querySelector(".lnQuitarFactura").addEventListener("click", () => {
          facturaDataInput.value = "";
          facturaPreview.innerHTML = "";
          facturaFile.value = "";
          facturaStatus.textContent = "";
        });
        const almCat = DIARIO_CATEGORIA_A_ALMACEN[categoria.value];
        autoRellenarProductoDesdeFactura(dataUrl, {
          productoField: producto,
          categorias: almCat ? [almCat] : null,
          cantidadInput: cantidad,
          unidadInput: unidad,
          precioInput: precio,
          montoInput: monto,
          statusEl: facturaStatus
        });
      } catch (err) {
        alert("No se pudo procesar la imagen: " + err.message);
      }
    });
  }

  function agregarLinea() {
    lineaSeq++;
    lineasHost.insertAdjacentHTML("beforeend", pintarLineaHtml(lineaSeq));
    wireLinea(lineasHost.querySelector(`[data-linea-id="${lineaSeq}"]`));
  }

  host.querySelector("#cmMontoDeclarado").addEventListener("input", actualizarResumen);
  host.querySelector("#cmAgregarLinea").addEventListener("click", agregarLinea);

  // Arranca con 2 líneas vacías para no obligar a tocar "Agregar línea" la primera vez.
  agregarLinea();
  agregarLinea();
  actualizarResumen();

  host.querySelector("#cmGuardarTodo").addEventListener("click", () => {
    const numeroCompra = host.querySelector("#cmNumero").value.trim();
    const fecha = host.querySelector("#cmFecha").value;
    const cuenta = host.querySelector("#cmCuenta").value;
    const montoDeclarado = Number(host.querySelector("#cmMontoDeclarado").value) || 0;
    const numeroComprobante = host.querySelector("#cmNumeroComprobante").value.trim();
    const beneficiario = host.querySelector("#cmBeneficiario").value.trim();
    if (!fecha) { alert("Cargá la fecha de la compra."); return; }

    const lineas = Array.from(lineasHost.querySelectorAll(".linea-row")).map(card => ({
      categoria: card.querySelector(".lnCategoria").value,
      subcategoria: card.querySelector(".lnProducto").value.trim(),
      cantidad: Number(card.querySelector(".lnCantidad").value) || 0,
      unidad: card.querySelector(".lnUnidad").value.trim(),
      precioUnitario: Number(card.querySelector(".lnPrecio").value) || 0,
      monto: Number(card.querySelector(".lnMonto").value) || 0,
      precioVentaLote: card.querySelector(".lnPrecioVenta").value !== "" ? Number(card.querySelector(".lnPrecioVenta").value) : undefined,
      facturaCompra: card.querySelector(".lnFacturaData").value || ""
    })).filter(l => l.categoria && l.monto > 0);

    if (!lineas.length) { alert("Agregá al menos una línea con categoría y monto."); return; }

    const totalLineas = sum(lineas.map(l => l.monto));
    if (montoDeclarado > 0 && Math.abs(totalLineas - montoDeclarado) > 0.01) {
      if (!confirm(`El total de las líneas (${fmtMoney2(totalLineas)}) no coincide con el monto del comprobante (${fmtMoney2(montoDeclarado)}). ¿Guardar igual?`)) return;
    }
    if (!confirmarSiNoEsDuplicado("diario", numeroComprobante)) return;

    lineas.forEach(l => {
      crudAdd("diario", {
        fecha, tipo: "EGRESO", categoria: l.categoria, subcategoria: l.subcategoria,
        descripcion: numeroCompra ? `Compra Nº ${numeroCompra}` : "",
        cuenta, monto: l.monto,
        cantidad: l.cantidad, unidad: l.unidad, precioUnitario: l.precioUnitario, precioVentaLote: l.precioVentaLote,
        numeroCompra, numeroComprobante, beneficiario, comprobante: cmComprobanteData, facturaCompra: l.facturaCompra
      });
    });

    alert(`Se cargaron ${lineas.length} producto(s) bajo la compra Nº ${numeroCompra || "(sin número)"}.`);
    renderDiario(root);
  });
}

/* ---------------------------- DIARIO: Adelantos y Víveres a Trabajadores ---------------------------- */
function renderDiarioPersonal(host, root) {
  if (!STATE.empleados.length) {
    host.innerHTML = `<div class="empty-state">Agregá empleados en <b>Personal → Sueldos (configuración)</b> primero para poder cargarles adelantos o consumos acá.</div>`;
    return;
  }
  const hoy = new Date().toISOString().slice(0, 10);
  host.innerHTML = `
    <div class="note">Cargá acá el adelanto en efectivo de cada trabajador, o lo que se lleva de víveres/pedidos varios o utensilios. Todo se descuenta de su sueldo del mes (se ve en <b>Personal → Planilla individual</b>, "Neto a pagar"). Los <b>adelantos en efectivo</b> además salen de la cuenta que elijas, así quedan reflejados en el Diario y en el Flujo de Caja; los víveres/pedidos y utensilios no mueven caja hoy — se descuentan directo del sueldo. Si el producto que le das ya está en <b>Almacén</b>, elegilo del desplegable para que se descuente del stock. Si es algo que recién compraste para dárselo ahora (nunca estuvo en stock), marcá <b>"Es una compra nueva"</b>: cargás precio de compra y precio de venta al trabajador, y la app registra sola la <b>entrada</b> a inventario (como una compra normal) y la <b>salida</b> al trabajador correspondiente — queda el rastro completo de ambos movimientos.</div>
    <div class="card form-card">
      <form id="personalQuickForm" autocomplete="off">
        <div class="form-grid">
          <div class="field"><label>Trabajador *</label>
            <select id="pqEmpleado" required>
              <option value=""></option>
              ${STATE.empleados.map(e => `<option value="${e.id}">${escapeHtml(e.cargo)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Tipo *</label>
            <select id="pqTipo" required>
              <option value="adelanto">Adelanto en efectivo</option>
              <option value="consumo">Víveres / Pedidos</option>
              <option value="utensilios">Utensilios</option>
            </select>
          </div>
          <div class="field"><label>Fecha *</label><input type="date" id="pqFecha" required value="${hoy}"></div>
          <div class="field" id="pqCompraNuevaToggleField" style="display:none">
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
              <input type="checkbox" id="pqEsCompraNueva" style="width:auto"> Es una compra nueva (recién comprado para este trabajador)
            </label>
          </div>
          <div class="field" id="pqProductoField" style="display:none">
            <label>Producto de almacén (opcional)</label>
            <select id="pqProducto">
              <option value="">— Sin producto / monto libre —</option>
              ${STATE.almacenProductos.filter(p => p.categoria === "Víveres" || p.categoria === "Accesorios" || p.categoria === "Herramientas").map(p =>
                `<option value="${p.id}" data-precio="${p.precioVentaTrabajador||0}" data-stock="${p.stock||0}">${escapeHtml(p.nombre)} (stock: ${fmtNum(p.stock||0)} ${escapeHtml(p.unidad||"")}, desde Bs ${fmtNum(p.precioVentaTrabajador||0)}/u por defecto)</option>`
              ).join("")}
            </select>
          </div>
          <div class="field" id="pqNuevoProductoField" style="display:none">
            <label>Producto (nuevo o existente)</label>
            <input type="text" id="pqNuevoProducto" list="pqNuevoProductoList" placeholder="Ej: Botas de goma, Machete…">
            <datalist id="pqNuevoProductoList">
              ${STATE.almacenProductos.filter(p => ALMACEN_CATEGORIAS_VENTA_PERSONAL.includes(p.categoria)).map(p => `<option value="${escapeHtml(p.nombre)}">`).join("")}
            </datalist>
          </div>
          <div class="field" id="pqNuevaCategoriaField" style="display:none">
            <label>Categoría</label>
            <select id="pqNuevaCategoria">
              <option value="Víveres">Víveres</option>
              <option value="Accesorios">Accesorios</option>
              <option value="Herramientas">Herramientas</option>
            </select>
          </div>
          <div class="field" id="pqCantidadField" style="display:none"><label>Cantidad</label><input type="number" step="0.01" id="pqCantidad" placeholder="0"></div>
          <div class="field" id="pqNuevaUnidadField" style="display:none">
            <label>Unidad</label>
            <input type="text" id="pqNuevaUnidad" list="pqNuevaUnidadList" placeholder="Kilos, Litros, Unidad…">
            <datalist id="pqNuevaUnidadList"><option value="Kilos"><option value="Litros"><option value="Unidad"><option value="Dosis"><option value="Bolsa"></datalist>
          </div>
          <div class="field" id="pqPrecioCompraField" style="display:none">
            <label>Precio de compra (Bs, unitario)</label>
            <input type="number" step="0.01" id="pqPrecioCompra" placeholder="0.00">
          </div>
          <div class="field" id="pqPrecioVentaNuevaField" style="display:none">
            <label>Precio de venta al trabajador (Bs, unitario)</label>
            <input type="number" step="0.01" id="pqPrecioVentaNueva" placeholder="0.00">
          </div>
          <div class="field"><label>Monto (Bs) *</label><input type="number" step="0.01" id="pqMonto" required></div>
          <div class="field"><label>Detalle</label><input type="text" id="pqDetalle" placeholder="Ej: arroz y aceite, adelanto quincena…"></div>
          <div class="field"><label>Cuenta (adelanto en efectivo, o de dónde salió la plata de la compra)</label>
            <select id="pqCuenta">
              <option value=""></option>
              ${STATE.cuentas.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Nº de comprobante</label><input type="text" id="pqNumeroComprobante" placeholder="Ej: Factura 00123"><div id="pqOcrStatus" class="ocr-status"></div></div>
          <div class="field"><label>Beneficiario / A quién fue el pago</label><input type="text" id="pqBeneficiario" placeholder="Nombre del proveedor o persona"></div>
          <div class="field"><label>Comprobante de pago (opcional)</label>
            <input type="file" id="pqComprobante" accept="image/*" capture="environment">
            <div id="pqComprobantePreview" class="img-preview-wrap"></div>
          </div>
          <div class="field" id="pqFacturaField" style="display:none"><label>Factura / Recibo de compra (opcional)</label>
            <input type="file" id="pqFactura" accept="image/*" capture="environment">
            <div id="pqFacturaPreview" class="img-preview-wrap"></div>
            <div id="pqFacturaOcrStatus" class="ocr-status"></div>
          </div>
        </div>
        <div class="note" style="margin-top:2px">Si elegís un <b>producto de almacén</b>, la cantidad se descuenta automáticamente del stock (pestaña <b>Almacén</b>) y el monto se calcula solo con el precio de venta al trabajador — lo podés ajustar a mano si hace falta. Si subís la <b>factura/recibo de compra</b>, se intenta reconocer el producto solo (contra lo que ya tengas cargado en Almacén).</div>
        <div class="form-actions"><button type="submit" class="btn">➕ Agregar</button></div>
      </form>
    </div>
    <div id="personalQuickTableHost" style="margin-top:16px"></div>
  `;

  const tipoSelect = host.querySelector("#pqTipo");
  const compraNuevaToggleField = host.querySelector("#pqCompraNuevaToggleField");
  const esCompraNuevaCheckbox = host.querySelector("#pqEsCompraNueva");
  const productoField = host.querySelector("#pqProductoField");
  const nuevoProductoField = host.querySelector("#pqNuevoProductoField");
  const nuevaCategoriaField = host.querySelector("#pqNuevaCategoriaField");
  const nuevaUnidadField = host.querySelector("#pqNuevaUnidadField");
  const precioCompraField = host.querySelector("#pqPrecioCompraField");
  const precioVentaNuevaField = host.querySelector("#pqPrecioVentaNuevaField");
  const cantidadField = host.querySelector("#pqCantidadField");
  const facturaField = host.querySelector("#pqFacturaField");
  const productoSelect = host.querySelector("#pqProducto");
  const nuevoProductoInput = host.querySelector("#pqNuevoProducto");
  const nuevaCategoriaSelect = host.querySelector("#pqNuevaCategoria");
  const nuevaUnidadInput = host.querySelector("#pqNuevaUnidad");
  const precioCompraInput = host.querySelector("#pqPrecioCompra");
  const precioVentaNuevaInput = host.querySelector("#pqPrecioVentaNueva");
  const cantidadInput = host.querySelector("#pqCantidad");
  const montoInput = host.querySelector("#pqMonto");

  function actualizarModoProducto() {
    const mostrar = tipoSelect.value === "consumo" || tipoSelect.value === "utensilios";
    const esNueva = mostrar && esCompraNuevaCheckbox.checked;
    productoField.style.display = (mostrar && !esNueva) ? "" : "none";
    nuevoProductoField.style.display = esNueva ? "" : "none";
    nuevaCategoriaField.style.display = esNueva ? "" : "none";
    nuevaUnidadField.style.display = esNueva ? "" : "none";
    precioCompraField.style.display = esNueva ? "" : "none";
    precioVentaNuevaField.style.display = esNueva ? "" : "none";
    if (esNueva) {
      productoSelect.value = "";
      nuevaCategoriaSelect.value = tipoSelect.value === "utensilios" ? "Herramientas" : "Víveres";
    } else {
      nuevoProductoInput.value = ""; nuevaUnidadInput.value = ""; precioCompraInput.value = ""; precioVentaNuevaInput.value = "";
    }
  }
  function actualizarVisibilidadProducto() {
    const mostrar = tipoSelect.value === "consumo" || tipoSelect.value === "utensilios";
    compraNuevaToggleField.style.display = mostrar ? "" : "none";
    cantidadField.style.display = mostrar ? "" : "none";
    facturaField.style.display = mostrar ? "" : "none";
    if (!mostrar) { productoSelect.value = ""; cantidadInput.value = ""; esCompraNuevaCheckbox.checked = false; }
    actualizarModoProducto();
  }
  function recalcularMontoDesdeProducto() {
    const opt = productoSelect.selectedOptions[0];
    if (!opt || !opt.value) return;
    const cant = Number(cantidadInput.value) || 0;
    if (cant <= 0) return;
    // Sigue FIFO: cobra el precio de venta de los lotes más viejos primero (cada compra
    // puede tener su propio precio para estos productos — Víveres, Accesorios, Herramientas).
    const { monto } = calcularMontoConsumoFIFO(STATE, opt.value, cant);
    montoInput.value = monto.toFixed(2);
  }
  function recalcularMontoDesdeCompraNueva() {
    if (!esCompraNuevaCheckbox.checked) return;
    const cant = Number(cantidadInput.value) || 0;
    const pv = Number(precioVentaNuevaInput.value) || 0;
    // Precio pactado para ESTA entrega puntual (no se mezcla con FIFO de otros lotes):
    // el usuario acaba de decidir a cuánto se lo vende al trabajador ahora mismo.
    if (cant > 0 && pv > 0) montoInput.value = (cant * pv).toFixed(2);
  }
  tipoSelect.addEventListener("change", actualizarVisibilidadProducto);
  esCompraNuevaCheckbox.addEventListener("change", actualizarModoProducto);
  productoSelect.addEventListener("change", recalcularMontoDesdeProducto);
  cantidadInput.addEventListener("input", () => { recalcularMontoDesdeProducto(); recalcularMontoDesdeCompraNueva(); });
  precioVentaNuevaInput.addEventListener("input", recalcularMontoDesdeCompraNueva);
  actualizarVisibilidadProducto();

  let pqComprobanteData = "";
  host.querySelector("#pqComprobante").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = host.querySelector("#pqComprobantePreview");
    try {
      pqComprobanteData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${pqComprobanteData}" class="img-preview"><button type="button" class="btn secondary small" id="pqQuitarComprobante">Quitar</button>`;
      host.querySelector("#pqQuitarComprobante").addEventListener("click", () => {
        pqComprobanteData = "";
        preview.innerHTML = "";
        host.querySelector("#pqComprobante").value = "";
        const st = host.querySelector("#pqOcrStatus"); if (st) st.textContent = "";
      });
      autoRellenarDesdeComprobante(pqComprobanteData, {
        numeroInput: host.querySelector("#pqNumeroComprobante"),
        montoInput: host.querySelector("#pqMonto"),
        fechaInput: host.querySelector("#pqFecha"),
        beneficiarioInput: host.querySelector("#pqBeneficiario"),
        cuentaSelect: host.querySelector("#pqCuenta"),
        statusEl: host.querySelector("#pqOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  let pqFacturaData = "";
  host.querySelector("#pqFactura").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = host.querySelector("#pqFacturaPreview");
    try {
      pqFacturaData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${pqFacturaData}" class="img-preview"><button type="button" class="btn secondary small" id="pqQuitarFactura">Quitar</button>`;
      host.querySelector("#pqQuitarFactura").addEventListener("click", () => {
        pqFacturaData = "";
        preview.innerHTML = "";
        host.querySelector("#pqFactura").value = "";
        const st = host.querySelector("#pqFacturaOcrStatus"); if (st) st.textContent = "";
      });
      autoRellenarProductoDesdeFactura(pqFacturaData, {
        productoField: productoSelect,
        categorias: ALMACEN_CATEGORIAS_VENTA_PERSONAL,
        cantidadInput: cantidadInput,
        statusEl: host.querySelector("#pqFacturaOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  host.querySelector("#personalQuickForm").addEventListener("submit", e => {
    e.preventDefault();
    const empleadoId = host.querySelector("#pqEmpleado").value;
    const tipo = host.querySelector("#pqTipo").value;
    const fecha = host.querySelector("#pqFecha").value;
    let monto = Number(host.querySelector("#pqMonto").value) || 0;
    const detalle = host.querySelector("#pqDetalle").value.trim();
    const cuenta = host.querySelector("#pqCuenta").value;
    const cantidad = Number(cantidadInput.value) || 0;
    const numeroComprobante = host.querySelector("#pqNumeroComprobante").value.trim();
    const beneficiario = host.querySelector("#pqBeneficiario").value.trim();
    const esCompraNueva = esCompraNuevaCheckbox.checked && (tipo === "consumo" || tipo === "utensilios");
    if (!empleadoId) { alert("Elegí un trabajador."); return; }

    let producto = null;
    let nombreNuevo = "", categoriaNueva = "", unidadNueva = "", precioCompra = 0, precioVentaNueva = 0;
    if (esCompraNueva) {
      nombreNuevo = nuevoProductoInput.value.trim();
      categoriaNueva = nuevaCategoriaSelect.value;
      unidadNueva = nuevaUnidadInput.value.trim();
      precioCompra = Number(precioCompraInput.value) || 0;
      precioVentaNueva = Number(precioVentaNuevaInput.value) || 0;
      if (!nombreNuevo || cantidad <= 0 || precioCompra <= 0 || precioVentaNueva <= 0) {
        alert("Para una compra nueva cargá el producto, la cantidad, el precio de compra y el precio de venta al trabajador.");
        return;
      }
      // Precio pactado para ESTA entrega puntual — no se calcula por FIFO porque es
      // exactamente lo que se acaba de comprar y entregar, no una mezcla de lotes viejos.
      monto = round2(cantidad * precioVentaNueva);
    } else {
      const productoId = productoSelect.value;
      producto = productoId ? STATE.almacenProductos.find(p => p.id === productoId) : null;
      if (producto && cantidad > (producto.stock || 0)) {
        if (!confirm(`Stock de "${producto.nombre}" es ${fmtNum(producto.stock||0)} ${producto.unidad||""} y estás por descontar ${fmtNum(cantidad)}. ¿Continuar igual?`)) return;
      }
    }

    if (!monto) { alert("Cargá un monto mayor a cero."); return; }
    if (!confirmarSiNoEsDuplicado("personalMovimientos", numeroComprobante)) return;

    const empleado = STATE.empleados.find(x => x.id === empleadoId);
    const tipoLabel = tipo === "adelanto" ? "Adelanto" : tipo === "consumo" ? "Víveres / Pedidos" : "Utensilios";

    // Compra nueva: primero se registra la ENTRADA a inventario (misma mecánica que una
    // compra normal del Diario — categoría de gasto correspondiente, suma stock con su
    // propio precio de venta por lote) y recién después la salida al trabajador, más abajo.
    if (esCompraNueva) {
      crudAdd("diario", {
        fecha, tipo: "EGRESO", categoria: ALMACEN_CATEGORIA_A_DIARIO[categoriaNueva],
        subcategoria: nombreNuevo,
        descripcion: `Compra para entregar a ${empleado ? empleado.cargo : "trabajador"}`,
        cuenta, monto: round2(cantidad * precioCompra),
        cantidad, unidad: unidadNueva, precioUnitario: precioCompra, precioVentaLote: precioVentaNueva,
        numeroComprobante, beneficiario,
        comprobante: pqComprobanteData, facturaCompra: pqFacturaData
      });
      producto = STATE.almacenProductos.find(p => p.nombre.trim().toLowerCase() === nombreNuevo.toLowerCase());
    }

    const conceptoBase = producto ? `${tipoLabel} — ${producto.nombre} x${cantidad}` : (detalle ? `${tipoLabel} — ${detalle}` : tipoLabel);
    const personalMov = crudAdd("personalMovimientos", {
      empleadoId, fecha,
      concepto: producto && detalle ? `${conceptoBase} (${detalle})` : conceptoBase,
      adelanto: tipo === "adelanto" ? monto : 0,
      utensilios: tipo === "utensilios" ? monto : 0,
      consumo: tipo === "consumo" ? monto : 0,
      observacion: esCompraNueva ? "Compra nueva entregada de inmediato al trabajador" : "",
      numeroComprobante, beneficiario,
      comprobante: pqComprobanteData, facturaCompra: pqFacturaData
    });

    if (tipo === "adelanto" && monto > 0) {
      crudAdd("diario", {
        fecha, tipo: "EGRESO", categoria: "Adelanto a Personal",
        subcategoria: empleado ? empleado.cargo : "",
        descripcion: `Adelanto a ${empleado ? empleado.cargo : ""}` + (detalle ? ` — ${detalle}` : ""),
        cuenta, monto,
        numeroComprobante, beneficiario,
        comprobante: pqComprobanteData, facturaCompra: pqFacturaData
      });
    }

    if (producto && cantidad > 0) {
      // precioUnitario acá queda como el precio efectivo de este consumo: en modo
      // "compra nueva" es exactamente el precio de venta pactado para esta entrega; en
      // el modo normal (producto ya en stock) puede combinar varios lotes a distinto
      // precio según FIFO — el monto real ya viene de calcularMontoConsumoFIFO()
      // (recalcularMontoDesdeProducto), o de lo que el usuario haya ajustado a mano.
      crudAdd("almacenMovimientos", {
        fecha, productoId: producto.id, tipo: "consumo_trabajador",
        cantidad, precioUnitario: round2(monto / cantidad), total: monto,
        empleadoId, personalMovId: personalMov.id,
        observacion: `${tipoLabel} a ${empleado ? empleado.cargo : ""}`,
        numeroComprobante, beneficiario,
        comprobante: pqComprobanteData, facturaCompra: pqFacturaData
      });
    }
    renderDiario(root);
  });

  host.querySelector("#personalQuickTableHost").insertAdjacentHTML("beforebegin", `<div class="section-title" style="margin-top:22px">Adelantos y consumos ya cargados (editar / borrar)</div>`);
  mountCrudTable(host.querySelector("#personalQuickTableHost"), {
    collection: "personalMovimientos",
    noAddForm: true,
    emptyText: "Todavía no cargaste adelantos ni consumos de trabajadores.",
    sortFn: (a,b) => (b.fecha||"").localeCompare(a.fecha||""),
    columns: [
      { key: "fecha", label: "Fecha", type: "date", required: true },
      { key: "empleadoId", label: "Trabajador", type: "select", options: () => STATE.empleados.map(e=>({value:e.id,label:e.cargo})), required: true },
      { key: "concepto", label: "Concepto / Detalle", type: "text" },
      { key: "adelanto", label: "Adelanto (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "utensilios", label: "Utensilios (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "consumo", label: "Víveres/Pedidos (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "observacion", label: "Observación", type: "text" },
      { key: "numeroComprobante", label: "Nº comprobante", type: "text" },
      { key: "beneficiario", label: "Beneficiario", type: "text" },
      { key: "comprobante", label: "Comprobante de pago", type: "image" },
      { key: "facturaCompra", label: "Factura / Recibo de compra", type: "image" }
    ],
    formatCell: (row, col) => {
      if (col.key === "empleadoId") { const e = STATE.empleados.find(x => x.id === row.empleadoId); return escapeHtml(e ? e.cargo : "—"); }
      if (["adelanto","utensilios","consumo"].includes(col.key)) return fmtMoney2(row[col.key]);
      return escapeHtml(row[col.key]);
    },
    footer: rows => `<tr><td colspan="3">Totales</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.adelanto)))}</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.utensilios)))}</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.consumo)))}</td><td></td><td></td><td></td><td></td><td></td></tr>`,
    onAfterChange: () => renderDiario(root)
  });
}

/* ==========================================================================
   GANADO — Movimientos (formulario dedicado con campos condicionales por tipo)
   ========================================================================== */
function renderGanadoMovimientos(host, root) {
  const hoy = new Date().toISOString().slice(0, 10);
  host.innerHTML = `
    <div class="note">Registrá acá cada compra (ENTRADA), venta (SALIDA), nacimiento o muerte de ganado. En <b>SALIDA</b> elegí el <b>tipo de venta</b> (Kilo Vivo, Kilo Gancho o Al Bulto): cada uno usa su propia base de cálculo, así que no se mezclan entre sí. También podés cargar el <b>destino</b> de la venta (frigorífico, feria, particular…) y el comprador. Si pagás <b>flete</b> por esta venta, cargá el Bs/cabeza o el total (se calculan uno del otro) — se descuenta solo de la rentabilidad de esta venta y se registra automáticamente como gasto "Flete / Transporte" en el Diario.</div>
    <div class="card form-card">
      <form id="gmForm" autocomplete="off">
        <div class="form-grid">
          <div class="field"><label>Fecha *</label><input type="date" id="gmFecha" required value="${hoy}"></div>
          <div class="field"><label>Tipo *</label>
            <select id="gmTipo" required>
              <option value="ENTRADA">ENTRADA (compra)</option>
              <option value="SALIDA">SALIDA (venta)</option>
              <option value="NACIMIENTO">NACIMIENTO</option>
              <option value="MUERTE">MUERTE</option>
            </select>
          </div>
          <div class="field"><label>Categoría *</label>
            <select id="gmCategoria" required>
              <option value=""></option>
              ${STATE.categoriasGanado.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Cabezas *</label><input type="number" step="1" id="gmCabezas" required></div>

          <div class="field gm-entrada-group"><label>Tipo de compra *</label>
            <select id="gmTipoCompra">
              <option value="Kilo Vivo">Kilo Vivo</option>
              <option value="Por Cabeza">Por Cabeza</option>
            </select>
          </div>
          <div class="field gm-entrada-group gm-entradakilo-group"><label>Kg vivos (compra)</label><input type="number" step="0.01" id="gmKgEntrada"></div>
          <div class="field gm-entrada-group gm-entradakilo-group"><label>Bs/kg (compra)</label><input type="number" step="0.01" id="gmBsKgEntrada"></div>
          <div class="field gm-entrada-group gm-entradacabeza-group"><label>Bs/cabeza (compra)</label><input type="number" step="0.01" id="gmBsCabEntrada"></div>

          <div class="field gm-entrada-group" style="grid-column:1 / -1">
            <label>Números de caravana de esta compra (opcional)</label>
            <textarea id="gmNumerosCaravana" rows="2" placeholder="Ej: A-101, A-102, A-103 (uno por línea o separados por coma)"></textarea>
            <div class="note" style="margin-top:4px">Si numerás cada res comprada, después vas a poder ver el costo real de compra de ESE animal puntual (no solo el promedio de la categoría) cuando lo vendas — útil para evaluar el negocio de compra-engorde-venta. Podés dejarlo vacío y cargar los números más tarde desde Ganado → Inventario Individual.</div>
          </div>

          <div class="field gm-salida-group"><label>Tipo de venta *</label>
            <select id="gmTipoVenta">${TIPOS_VENTA_GANADO.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}</select>
          </div>

          <div class="field gm-salida-group gm-kilovivo-group"><label>Kg vivos (venta)</label><input type="number" step="0.01" id="gmKgSalida"></div>
          <div class="field gm-salida-group gm-kilovivo-group"><label>Bs/kg vivo (venta)</label><input type="number" step="0.01" id="gmBsKgSalida"></div>

          <div class="field gm-salida-group gm-kilogancho-group"><label>Kg gancho (canal)</label><input type="number" step="0.01" id="gmKgGancho"></div>
          <div class="field gm-salida-group gm-kilogancho-group"><label>Bs/kg gancho</label><input type="number" step="0.01" id="gmBsKgGancho"></div>
          <div class="field gm-salida-group gm-kilogancho-group"><label>Rendimiento carcasa % (opcional)</label><input type="number" step="0.1" id="gmRendimiento" placeholder="Ej: 54"></div>

          <div class="field gm-salida-group gm-albulto-group"><label>Monto total pactado (Bs)</label><input type="number" step="0.01" id="gmMontoBulto"></div>

          <div class="field gm-salida-group"><label>Flete Bs/cabeza (opcional)</label><input type="number" step="0.01" id="gmFleteBsCab" placeholder="Ej: 50"></div>
          <div class="field gm-salida-group"><label>Flete total (Bs)</label><input type="number" step="0.01" id="gmFleteTotal" placeholder="Se calcula solo, o cargalo directo"></div>

          <div class="field gm-salida-group"><label>Destino</label>
            <select id="gmDestino">
              <option value=""></option>
              ${DESTINOS_VENTA_GANADO.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
            </select>
          </div>
          <div class="field gm-salida-group"><label>Comprador (opcional)</label><input type="text" id="gmComprador" placeholder="Nombre del comprador / frigorífico"></div>

          <div class="field gm-money-group"><label>Cuenta</label>
            <select id="gmCuenta">
              <option value=""></option>
              ${STATE.cuentas.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Observaciones</label><input type="text" id="gmObservaciones"></div>
          <div class="field gm-money-group"><label>Nº de comprobante</label><input type="text" id="gmNumeroComprobante" placeholder="Ej: Factura 00123"><div id="gmOcrStatus" class="ocr-status"></div></div>
          <div class="field gm-entrada-group"><label>Beneficiario / A quién fue el pago (vendedor)</label><input type="text" id="gmBeneficiario" placeholder="Nombre del vendedor"></div>
          <div class="field gm-money-group"><label>Comprobante (opcional)</label>
            <input type="file" id="gmComprobante" accept="image/*" capture="environment">
            <div id="gmComprobantePreview" class="img-preview-wrap"></div>
          </div>
        </div>
        <div class="note gm-money-group" style="margin-top:4px">Monto total estimado: <b id="gmMontoPreview">Bs 0.00</b></div>
        <div class="form-actions"><button type="submit" class="btn">➕ Agregar movimiento</button></div>
      </form>
    </div>
    <div id="ganadoTableHost" style="margin-top:16px"></div>
  `;

  const gmTipo = host.querySelector("#gmTipo");
  const gmTipoVenta = host.querySelector("#gmTipoVenta");
  const gmTipoCompra = host.querySelector("#gmTipoCompra");
  const gmKgEntrada = host.querySelector("#gmKgEntrada");
  const gmBsKgEntrada = host.querySelector("#gmBsKgEntrada");
  const gmBsCabEntrada = host.querySelector("#gmBsCabEntrada");
  const gmKgSalida = host.querySelector("#gmKgSalida");
  const gmBsKgSalida = host.querySelector("#gmBsKgSalida");
  const gmKgGancho = host.querySelector("#gmKgGancho");
  const gmBsKgGancho = host.querySelector("#gmBsKgGancho");
  const gmMontoBulto = host.querySelector("#gmMontoBulto");
  const gmMontoPreview = host.querySelector("#gmMontoPreview");
  const gmCabezas = host.querySelector("#gmCabezas");
  const gmFleteBsCab = host.querySelector("#gmFleteBsCab");
  const gmFleteTotal = host.querySelector("#gmFleteTotal");

  function actualizarVisibilidadTipoVenta() {
    const tv = gmTipoVenta.value;
    host.querySelectorAll(".gm-kilovivo-group").forEach(el => el.style.display = tv === "Kilo Vivo" ? "" : "none");
    host.querySelectorAll(".gm-kilogancho-group").forEach(el => el.style.display = tv === "Kilo Gancho" ? "" : "none");
    host.querySelectorAll(".gm-albulto-group").forEach(el => el.style.display = tv === "Al Bulto" ? "" : "none");
  }
  function actualizarVisibilidadTipoCompra() {
    const tc = gmTipoCompra.value;
    host.querySelectorAll(".gm-entradakilo-group").forEach(el => el.style.display = tc === "Kilo Vivo" ? "" : "none");
    host.querySelectorAll(".gm-entradacabeza-group").forEach(el => el.style.display = tc === "Por Cabeza" ? "" : "none");
  }
  function actualizarVisibilidadGanado() {
    const tipo = gmTipo.value;
    host.querySelectorAll(".gm-entrada-group").forEach(el => el.style.display = tipo === "ENTRADA" ? "" : "none");
    host.querySelectorAll(".gm-salida-group").forEach(el => el.style.display = tipo === "SALIDA" ? "" : "none");
    host.querySelectorAll(".gm-money-group").forEach(el => el.style.display = (tipo === "ENTRADA" || tipo === "SALIDA") ? "" : "none");
    if (tipo === "SALIDA") actualizarVisibilidadTipoVenta();
    if (tipo === "ENTRADA") actualizarVisibilidadTipoCompra();
    actualizarMontoPreview();
  }
  function actualizarMontoPreview() {
    const tipo = gmTipo.value;
    let monto = 0;
    if (tipo === "ENTRADA") {
      const tc = gmTipoCompra.value;
      monto = tc === "Por Cabeza"
        ? (Number(gmCabezas.value) || 0) * (Number(gmBsCabEntrada.value) || 0)
        : (Number(gmKgEntrada.value) || 0) * (Number(gmBsKgEntrada.value) || 0);
    } else if (tipo === "SALIDA") {
      const tv = gmTipoVenta.value;
      if (tv === "Kilo Gancho") monto = (Number(gmKgGancho.value) || 0) * (Number(gmBsKgGancho.value) || 0);
      else if (tv === "Al Bulto") monto = Number(gmMontoBulto.value) || 0;
      else monto = (Number(gmKgSalida.value) || 0) * (Number(gmBsKgSalida.value) || 0);
    }
    gmMontoPreview.textContent = fmtMoney2(monto);
  }
  // Flete: Bs/cabeza y Flete total se calculan uno del otro tomando las Cabezas como ancla
  // (mismo patrón que cantidad/precio/monto del Diario) — cargar cualquiera de los dos alcanza.
  function actualizarFleteDesdeBsCab() {
    const cabezas = Number(gmCabezas.value) || 0;
    const bsCab = Number(gmFleteBsCab.value) || 0;
    if (cabezas > 0) gmFleteTotal.value = bsCab ? (Math.round(bsCab * cabezas * 100) / 100) : "";
  }
  function actualizarFleteDesdeTotal() {
    const cabezas = Number(gmCabezas.value) || 0;
    const total = Number(gmFleteTotal.value) || 0;
    if (cabezas > 0) gmFleteBsCab.value = total ? (Math.round((total / cabezas) * 100) / 100) : "";
  }
  gmFleteBsCab.addEventListener("input", actualizarFleteDesdeBsCab);
  gmFleteTotal.addEventListener("input", actualizarFleteDesdeTotal);
  gmCabezas.addEventListener("input", () => {
    if (gmFleteBsCab.value !== "") actualizarFleteDesdeBsCab();
    else if (gmFleteTotal.value !== "") actualizarFleteDesdeTotal();
    actualizarMontoPreview();
  });

  gmTipo.addEventListener("change", actualizarVisibilidadGanado);
  gmTipoVenta.addEventListener("change", actualizarVisibilidadTipoVenta);
  gmTipoCompra.addEventListener("change", () => { actualizarVisibilidadTipoCompra(); actualizarMontoPreview(); });
  [gmKgEntrada, gmBsKgEntrada, gmBsCabEntrada, gmKgSalida, gmBsKgSalida, gmKgGancho, gmBsKgGancho, gmMontoBulto]
    .forEach(el => el.addEventListener("input", actualizarMontoPreview));
  actualizarVisibilidadGanado();

  let gmComprobanteData = "";
  host.querySelector("#gmComprobante").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = host.querySelector("#gmComprobantePreview");
    try {
      gmComprobanteData = await fileToCompressedDataURL(file);
      preview.innerHTML = `<img src="${gmComprobanteData}" class="img-preview"><button type="button" class="btn secondary small" id="gmQuitarComprobante">Quitar</button>`;
      host.querySelector("#gmQuitarComprobante").addEventListener("click", () => {
        gmComprobanteData = "";
        preview.innerHTML = "";
        host.querySelector("#gmComprobante").value = "";
        const st = host.querySelector("#gmOcrStatus"); if (st) st.textContent = "";
      });
      autoRellenarDesdeComprobante(gmComprobanteData, {
        numeroInput: host.querySelector("#gmNumeroComprobante"),
        montoInput: host.querySelector("#gmMontoBulto"),
        fechaInput: host.querySelector("#gmFecha"),
        beneficiarioInput: host.querySelector("#gmBeneficiario"),
        cuentaSelect: host.querySelector("#gmCuenta"),
        statusEl: host.querySelector("#gmOcrStatus")
      });
    } catch (err) {
      alert("No se pudo procesar la imagen: " + err.message);
    }
  });

  host.querySelector("#gmForm").addEventListener("submit", e => {
    e.preventDefault();
    const fecha = host.querySelector("#gmFecha").value;
    const tipo = gmTipo.value;
    const categoria = host.querySelector("#gmCategoria").value;
    const cabezas = Number(host.querySelector("#gmCabezas").value) || 0;
    if (!fecha || !categoria || !cabezas) { alert("Cargá al menos fecha, categoría y cabezas."); return; }

    const row = { fecha, tipo, categoria, cabezas, observaciones: host.querySelector("#gmObservaciones").value.trim() };

    if (tipo === "ENTRADA") {
      const tc = gmTipoCompra.value || "Kilo Vivo";
      row.tipoCompra = tc;
      if (tc === "Por Cabeza") {
        row.bsCabEntrada = Number(gmBsCabEntrada.value) || 0;
      } else {
        row.kgEntrada = Number(gmKgEntrada.value) || 0;
        row.bsKgEntrada = Number(gmBsKgEntrada.value) || 0;
      }
      row.cuenta = host.querySelector("#gmCuenta").value;
      row.numeroComprobante = host.querySelector("#gmNumeroComprobante").value.trim();
      row.beneficiario = host.querySelector("#gmBeneficiario").value.trim();
      row.comprobante = gmComprobanteData;
    } else if (tipo === "SALIDA") {
      const tv = gmTipoVenta.value || "Kilo Vivo";
      row.tipoVenta = tv;
      if (tv === "Kilo Gancho") {
        row.kgGanchoSalida = Number(gmKgGancho.value) || 0;
        row.bsKgGanchoSalida = Number(gmBsKgGancho.value) || 0;
        row.rendimientoPct = Number(host.querySelector("#gmRendimiento").value) || 0;
      } else if (tv === "Al Bulto") {
        row.montoTotalSalida = Number(gmMontoBulto.value) || 0;
      } else {
        row.kgSalida = Number(gmKgSalida.value) || 0;
        row.bsKgSalida = Number(gmBsKgSalida.value) || 0;
      }
      row.destino = host.querySelector("#gmDestino").value;
      row.comprador = host.querySelector("#gmComprador").value.trim();
      row.fleteTotal = Number(gmFleteTotal.value) || 0;
      row.fleteBsCab = Number(gmFleteBsCab.value) || 0;
      row.cuenta = host.querySelector("#gmCuenta").value;
      row.numeroComprobante = host.querySelector("#gmNumeroComprobante").value.trim();
      row.comprobante = gmComprobanteData;
    }

    if (!confirmarSiNoEsDuplicado("ganadoMovimiento", row.numeroComprobante)) return;

    const nuevo = crudAdd("ganadoMovimiento", row);

    if (tipo === "ENTRADA") {
      const numerosTexto = host.querySelector("#gmNumerosCaravana").value.trim();
      if (numerosTexto) {
        const r = registrarAnimalesDeCompra(nuevo.id, numerosTexto);
        if (r.error) {
          alert(r.error);
        } else {
          let msg = `Se registraron ${r.creados} animal(es) con su número de caravana (costo de compra: ${fmtMoney2(r.costoUnitario)}/cabeza).`;
          if (r.omitidos.length) msg += `\nOmitidos por ya existir: ${r.omitidos.join(", ")}.`;
          alert(msg);
        }
      }
    }

    renderGanado(root);
  });

  host.querySelector("#ganadoTableHost").insertAdjacentHTML("beforebegin", `<div class="section-title" style="margin-top:22px">Movimientos ya cargados (editar / borrar)</div>`);
  mountCrudTable(host.querySelector("#ganadoTableHost"), {
    collection: "ganadoMovimiento",
    noAddForm: true,
    emptyText: "Todavía no cargaste movimientos de ganado.",
    sortFn: (a,b) => (b.fecha||"").localeCompare(a.fecha||""),
    columns: [
      { key: "fecha", label: "Fecha", type: "date", required: true },
      { key: "tipo", label: "Tipo", type: "select", options: ["ENTRADA","SALIDA","NACIMIENTO","MUERTE"], required: true, default: "ENTRADA" },
      { key: "categoria", label: "Categoría", type: "select", options: () => STATE.categoriasGanado.map(c=>c.nombre), required: true },
      { key: "cabezas", label: "Cabezas", type: "number", step: "1", numeric: true, required: true },
      { key: "tipoCompra", label: "Tipo de compra", type: "select", options: ["Kilo Vivo","Por Cabeza"], default: "Kilo Vivo" },
      { key: "kgEntrada", label: "Kg vivos (compra)", type: "number", step: "0.01", numeric: true },
      { key: "bsKgEntrada", label: "Bs/kg (compra)", type: "number", step: "0.01", numeric: true },
      { key: "bsCabEntrada", label: "Bs/cabeza (compra)", type: "number", step: "0.01", numeric: true },
      { key: "tipoVenta", label: "Tipo de venta", type: "select", options: TIPOS_VENTA_GANADO },
      { key: "kgSalida", label: "Kg vivos (venta)", type: "number", step: "0.01", numeric: true },
      { key: "bsKgSalida", label: "Bs/kg vivo (venta)", type: "number", step: "0.01", numeric: true },
      { key: "kgGanchoSalida", label: "Kg gancho", type: "number", step: "0.01", numeric: true },
      { key: "bsKgGanchoSalida", label: "Bs/kg gancho", type: "number", step: "0.01", numeric: true },
      { key: "rendimientoPct", label: "Rendim. %", type: "number", step: "0.1", numeric: true },
      { key: "montoTotalSalida", label: "Monto al bulto (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "destino", label: "Destino", type: "select", options: DESTINOS_VENTA_GANADO },
      { key: "comprador", label: "Comprador", type: "text" },
      { key: "fleteBsCab", label: "Flete Bs/cab", type: "number", step: "0.01", numeric: true },
      { key: "fleteTotal", label: "Flete total (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "cuenta", label: "Cuenta", type: "select", options: () => STATE.cuentas.map(c=>c.nombre) },
      { key: "observaciones", label: "Observaciones", type: "text" },
      { key: "numeroComprobante", label: "Nº comprobante", type: "text" },
      { key: "beneficiario", label: "Beneficiario", type: "text" },
      { key: "comprobante", label: "Comprobante", type: "image" }
    ],
    extraColumns: [
      { label: "Total (Bs)", numeric: true, render: row => fmtMoney2(montoTotalGanadoRow(row)) }
    ],
    formatCell: (row, col) => {
      if (col.key === "tipo") return `<span class="tag ${(row.tipo==='ENTRADA'||row.tipo==='NACIMIENTO')?'ingreso':'egreso'}">${row.tipo}</span>`;
      if (["kgEntrada","bsKgEntrada","bsCabEntrada","kgSalida","bsKgSalida","kgGanchoSalida","bsKgGanchoSalida","rendimientoPct","montoTotalSalida","fleteBsCab","fleteTotal"].includes(col.key)) {
        return row[col.key] ? fmtNum(row[col.key]) : "—";
      }
      return escapeHtml(row[col.key]);
    },
    onAfterChange: () => renderGanado(root)
  });
}

/* ==========================================================================
   GANADO (movimientos + inventario)
   ========================================================================== */
function renderGanado(root) {
  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="movimientos">Movimientos</button>
      <button class="tab-btn" data-tab="inventario">Inventario y Valuación</button>
      <button class="tab-btn" data-tab="levantamiento">Levantamiento (CREA)</button>
      <button class="tab-btn" data-tab="animales">Inventario Individual</button>
      <button class="tab-btn" data-tab="bajas">Bajas y Salidas</button>
    </div>
    <div id="ganadoContent"></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => {
    if (b.dataset.tab === uiState.ganadoTab) b.classList.add("active");
    b.addEventListener("click", () => { uiState.ganadoTab = b.dataset.tab; renderGanado(root); });
  });
  const host = root.querySelector("#ganadoContent");

  if (uiState.ganadoTab === "movimientos") {
    renderGanadoMovimientos(host, root);
  } else if (uiState.ganadoTab === "inventario") {
    const inv = calcGanadoInventario(STATE);
    host.innerHTML = `
      <div class="grid cols-4">
        <div class="card kpi"><span class="kpi-label">Stock actual</span><span class="kpi-value">${fmtNum(inv.totalStockActual)}</span></div>
        <div class="card kpi"><span class="kpi-label">Valor actual del rodeo</span><span class="kpi-value">${fmtMoney(inv.totalValorActual)}</span></div>
        <div class="card kpi"><span class="kpi-label">Total EV</span><span class="kpi-value">${fmtNum(inv.totalEV)}</span></div>
        <div class="card kpi"><span class="kpi-label">Carga animal (EV/ha)</span><span class="kpi-value">${fmtNum(inv.cargaAnimalEVporHa)}</span></div>
      </div>
      <div class="section" style="margin-top:16px">
      <div class="table-wrap"><table>
        <thead><tr><th>Categoría</th><th class="num">Stock inicial</th><th class="num">Entradas</th><th class="num">Nacim.</th><th class="num">Salidas</th><th class="num">Muertes</th><th class="num">Stock actual</th><th class="num">Coef. EV</th><th class="num">EV actual</th><th class="num">Precio Bs/cab</th><th class="num">Valor actual</th></tr></thead>
        <tbody>
          ${inv.filas.map(f => `<tr class="${f.stockActual<0?'':''}">
            <td>${escapeHtml(f.categoria)}</td>
            <td class="num">${fmtNum(f.stockInicial)}</td>
            <td class="num">${fmtNum(f.entradas)}</td>
            <td class="num">${fmtNum(f.nacimientos)}</td>
            <td class="num">${fmtNum(f.salidas)}</td>
            <td class="num">${fmtNum(f.muertes)}</td>
            <td class="num" style="${f.stockActual<0?'color:var(--red);font-weight:700':''}">${fmtNum(f.stockActual)}</td>
            <td class="num">${fmtNum(f.coefEV)}</td>
            <td class="num">${fmtNum(f.evActual)}</td>
            <td class="num">${fmtMoney2(f.precioBsCab)}</td>
            <td class="num">${fmtMoney(f.valorActual)}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr><td>TOTAL</td><td class="num">${fmtNum(inv.totalStockInicial)}</td><td class="num">${fmtNum(inv.totalEntradas)}</td><td class="num">${fmtNum(inv.totalNacimientos)}</td><td class="num">${fmtNum(inv.totalSalidas)}</td><td class="num">${fmtNum(inv.totalMuertes)}</td><td class="num">${fmtNum(inv.totalStockActual)}</td><td></td><td class="num">${fmtNum(inv.totalEV)}</td><td></td><td class="num">${fmtMoney(inv.totalValorActual)}</td></tr></tfoot>
      </table></div>
      </div>
      <div class="note">El precio Bs/cabeza y el peso promedio se cargan en la pestaña <b>Levantamiento (CREA)</b>.</div>
    `;
  } else if (uiState.ganadoTab === "levantamiento") {
    // Levantamiento CREA — stock inicial + precio por categoría
    host.innerHTML = `
      <div class="note">Es el conteo físico del rodeo (una vez al año o cuando quieras "resetear" el stock inicial) y también sirve para <b>precificar toda la compra inicial de ganado por categoría</b>. El coeficiente EV ya viene configurado en <b>Configuración</b>. Si compraste una categoría <b>al bulto</b> (un monto total por todo el lote, no un precio por kilo ni por cabeza), cargá ese monto en <b>"Monto total al bulto"</b> y el <b>Precio (Bs/cab)</b> se calcula solo dividiendo entre las cabezas — es el mismo campo que después usa el resto de la app para valuar el rodeo, el "monto al bulto" es solo una ayuda para no tener que dividir a mano. La columna <b>Valor total</b> y el total de abajo muestran cuánto vale (o cuánto costó) todo el inventario inicial, sumando todas las categorías.</div>
      <div class="card form-card">
        <div class="form-grid">
          <div class="field"><label>Fecha del levantamiento</label><input type="date" id="invFecha" value="${escapeHtml(STATE.inventarioCrea.fecha||'')}"></div>
          <div class="field"><label>Superficie ganadera (ha)</label><input type="number" step="0.01" id="invSuperficie" value="${STATE.inventarioCrea.superficieHa||0}"></div>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Categoría</th><th class="num">Cabezas (stock inicial)</th><th class="num">Peso prom (kg/cab)</th><th class="num">Monto total al bulto (Bs)</th><th class="num">Precio (Bs/cab)</th><th class="num">Valor total (Bs)</th></tr></thead>
        <tbody>
          ${STATE.categoriasGanado.map(cat => {
            const row = STATE.inventarioCreaCategorias.find(r => r.categoriaId === cat.id) || {};
            const valorTotal = (Number(row.cabezas)||0) * (Number(row.precioBsCab)||0);
            return `<tr data-catid="${cat.id}">
              <td>${escapeHtml(cat.nombre)}</td>
              <td class="num"><input type="number" step="1" class="inv-cabezas" value="${row.cabezas||0}" style="width:90px"></td>
              <td class="num"><input type="number" step="0.01" class="inv-peso" value="${row.pesoProm||0}" style="width:90px"></td>
              <td class="num"><input type="number" step="0.01" class="inv-montobulto" placeholder="Opcional" style="width:110px"></td>
              <td class="num"><input type="number" step="0.01" class="inv-precio" value="${row.precioBsCab||0}" style="width:100px"></td>
              <td class="num inv-valortotal">${fmtMoney2(valorTotal)}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot><tr><td>TOTAL</td><td class="num" id="invTotalCabezas">0</td><td></td><td></td><td></td><td class="num" id="invTotalValor">Bs 0.00</td></tr></tfoot>
      </table></div>
      <div style="margin-top:12px"><button class="btn" id="btnGuardarInv">Guardar levantamiento</button></div>
      <div class="card tight" style="margin-top:16px">
        <div class="section-title" style="margin-top:0">Registrar como compra de ganado (asiento contable)</div>
        <div class="note">Esto crea (o actualiza) una <b>ENTRADA de compra</b> en Ganado → Movimientos por cada categoría con cabezas y precio cargados arriba, usando el <b>Precio (Bs/cab)</b> ya guardado — así el monto sale de una cuenta real y entra automáticamente al Estado de Resultados y al Flujo de Caja como una salida de dinero de la empresa. Es una acción aparte de "Guardar levantamiento" (ese botón solo guarda el conteo/precio; este además genera el asiento contable). Si volvés a apretarlo después de corregir un precio, actualiza el mismo movimiento en vez de duplicarlo — nunca registra la misma compra dos veces.</div>
        <div class="form-grid">
          <div class="field"><label>Cuenta de la compra</label>
            <select id="invCompraCuenta">
              <option value="">Elegí cuenta…</option>
              ${STATE.cuentas.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Vendedor / Beneficiario (opcional)</label><input type="text" id="invCompraBeneficiario"></div>
          <div class="field"><label>Nº de comprobante (opcional)</label><input type="text" id="invCompraComprobante"></div>
        </div>
        <div class="form-actions"><button class="btn" id="btnRegistrarCompraGanado" type="button">💰 Registrar compra de ganado</button></div>
      </div>
    `;
    // "Monto total al bulto" es solo una calculadora auxiliar (no se guarda en el estado):
    // al cargarlo, completa el Precio (Bs/cab) dividiendo entre las cabezas de esa fila.
    // Si en cambio se edita el Precio (Bs/cab) directo, se recalcula el monto al bulto
    // equivalente, para poder ir y volver entre las dos formas de cargar el dato.
    // "Valor total" (por fila) y el TOTAL general de abajo se recalculan en vivo con
    // cualquier cambio de Cabezas o Precio — es la forma de ver cuánto vale/costó toda
    // la compra inicial de ganado, sumando todas las categorías.
    function actualizarTotalesInv() {
      let totalCabezas = 0, totalValor = 0;
      host.querySelectorAll("tbody tr").forEach(tr => {
        const cabezas = Number(tr.querySelector(".inv-cabezas").value) || 0;
        const precio = Number(tr.querySelector(".inv-precio").value) || 0;
        const valorTotal = cabezas * precio;
        tr.querySelector(".inv-valortotal").textContent = fmtMoney2(valorTotal);
        totalCabezas += cabezas;
        totalValor += valorTotal;
      });
      host.querySelector("#invTotalCabezas").textContent = fmtNum(totalCabezas);
      host.querySelector("#invTotalValor").textContent = fmtMoney2(totalValor);
    }
    host.querySelectorAll("tbody tr").forEach(tr => {
      const cabezasInput = tr.querySelector(".inv-cabezas");
      const montoBultoInput = tr.querySelector(".inv-montobulto");
      const precioInput = tr.querySelector(".inv-precio");
      montoBultoInput.addEventListener("input", () => {
        const cabezas = Number(cabezasInput.value) || 0;
        const monto = Number(montoBultoInput.value) || 0;
        if (cabezas > 0) precioInput.value = (monto / cabezas).toFixed(2);
        actualizarTotalesInv();
      });
      precioInput.addEventListener("input", () => {
        const cabezas = Number(cabezasInput.value) || 0;
        const precio = Number(precioInput.value) || 0;
        if (cabezas > 0) montoBultoInput.value = (precio * cabezas).toFixed(2);
        actualizarTotalesInv();
      });
      cabezasInput.addEventListener("input", actualizarTotalesInv);
    });
    actualizarTotalesInv();
    function guardarLevantamientoDesdeForm() {
      STATE.inventarioCrea.fecha = host.querySelector("#invFecha").value;
      STATE.inventarioCrea.superficieHa = Number(host.querySelector("#invSuperficie").value) || 0;
      host.querySelectorAll("tbody tr").forEach(tr => {
        const catId = tr.dataset.catid;
        const cabezas = Number(tr.querySelector(".inv-cabezas").value) || 0;
        const pesoProm = Number(tr.querySelector(".inv-peso").value) || 0;
        const precioBsCab = Number(tr.querySelector(".inv-precio").value) || 0;
        let rec = STATE.inventarioCreaCategorias.find(r => r.categoriaId === catId);
        if (!rec) { rec = { categoriaId: catId }; STATE.inventarioCreaCategorias.push(rec); }
        Object.assign(rec, { cabezas, pesoProm, precioBsCab });
      });
      saveState();
    }
    host.querySelector("#btnGuardarInv").addEventListener("click", () => {
      guardarLevantamientoDesdeForm();
      alert("Levantamiento guardado.");
      renderGanado(root);
    });
    host.querySelector("#btnRegistrarCompraGanado").addEventListener("click", () => {
      const cuenta = host.querySelector("#invCompraCuenta").value;
      const beneficiario = host.querySelector("#invCompraBeneficiario").value.trim();
      const numeroComprobante = host.querySelector("#invCompraComprobante").value.trim();
      if (!cuenta && !confirm("No elegiste una cuenta — el gasto va a quedar sin cuenta asignada. ¿Registrar igual?")) return;
      guardarLevantamientoDesdeForm(); // aseguramos que quede guardado lo que se ve en pantalla antes de generar el asiento
      const r = syncEntradaCompraDesdeLevantamiento({ cuenta, beneficiario, numeroComprobante });
      alert(`Listo: ${r.creadas} compra(s) nueva(s), ${r.actualizadas} actualizada(s)${r.eliminadas ? `, ${r.eliminadas} eliminada(s) (categorías sin cabezas/precio)` : ""}. Total registrado: ${fmtMoney2(r.totalBs)}. Ya está reflejado en Ganado → Movimientos, Estado de Resultados y Flujo de Caja.`);
      renderGanado(root);
    });
  } else if (uiState.ganadoTab === "animales") {
    // Inventario individual — animales con numeración/caravana, importado desde Excel
    // Solo se listan acá los ACTIVOS: los vendidos/muertos se ven en "Bajas y Salidas".
    const activos = STATE.animales.filter(a => (a.estado||"ACTIVO").toUpperCase() === "ACTIVO");
    host.innerHTML = `
      <div class="note">Subí tu planilla Excel con las existencias y numeración (arete) de tus animales para armar el inventario individual. La app reconoce columnas como Número/Arete, Marca de origen (la marca con la que se compró el animal — útil para trazabilidad, ya que la marca actual de todo el rodeo es la de Los Cepes), Categoría, Color de arete, Sexo, Peso, Fecha de nacimiento, Potrero y Estado (no importa el orden). Si aparece una categoría nueva, se crea sola. Al importar, se actualiza el stock inicial en <b>Levantamiento (CREA)</b>.</div>
      <div class="card" style="margin-bottom:16px">
        <label class="btn secondary" style="cursor:pointer;display:inline-block">⬆️ Subir planilla de inventario (.xlsx)
          <input type="file" id="fileAnimales" accept=".xlsx,.xls" style="display:none">
        </label>
        <button class="btn secondary" id="btnPlantillaAnimales">⬇️ Descargar planilla modelo</button>
        <div id="importAnimalesResult" style="margin-top:10px;font-size:13px"></div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card kpi"><span class="kpi-label">Animales activos</span><span class="kpi-value">${fmtNum(activos.length)}</span></div>
        <div class="card kpi"><span class="kpi-label">Total registrados</span><span class="kpi-value">${fmtNum(STATE.animales.length)}</span></div>
      </div>
      <div class="card tight" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Agregar caravanas a una compra ya cargada</div>
        <div class="note">Si compraste ganado para engorde (Ganado → Movimientos, ENTRADA) y todavía no le pusiste el número de caravana a cada res, hacelo acá — así podés rastrear el costo real de compra de cada animal cuando lo vendas, en vez de usar solo el promedio de la categoría.</div>
        <div class="form-grid">
          <div class="field" style="grid-column:1 / -1">
            <label>Compra (ENTRADA de Ganado → Movimientos)</label>
            <select id="animCompraSel">
              <option value="">Elegí una compra…</option>
              ${STATE.ganadoMovimiento.filter(m => m.tipo === "ENTRADA").sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")).map(m => `<option value="${m.id}">${fmtDate(m.fecha)} · ${escapeHtml(m.categoria)} · ${fmtNum(m.cabezas)} cab. · ${fmtMoney2(montoTotalGanadoRow(m))}</option>`).join("")}
            </select>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label>Números de caravana</label>
            <textarea id="animNumerosCaravana" rows="2" placeholder="Ej: A-101, A-102, A-103 (uno por línea o separados por coma)"></textarea>
          </div>
        </div>
        <div class="form-actions"><button class="btn" id="btnAgregarCaravanas" type="button">Registrar animales</button></div>
      </div>
      <div id="animalesTableHost"></div>
    `;
    host.querySelector("#fileAnimales").addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      const res = host.querySelector("#importAnimalesResult");
      res.textContent = "Importando…";
      try {
        const r = await importInventarioAnimalesExcel(file);
        res.textContent = `Listo: ${r.importados} animales importados (${r.categorias} categorías, total ${r.total}). Se actualizó el stock inicial en Levantamiento (CREA).`;
        renderGanado(root);
      } catch (err) {
        console.error(err);
        res.textContent = "No se pudo leer la planilla: " + err.message;
      }
    });
    host.querySelector("#btnPlantillaAnimales").addEventListener("click", () => exportPlantillaAnimales());

    host.querySelector("#btnAgregarCaravanas").addEventListener("click", () => {
      const ganadoMovId = host.querySelector("#animCompraSel").value;
      const numerosTexto = host.querySelector("#animNumerosCaravana").value.trim();
      if (!ganadoMovId) { alert("Elegí a qué compra corresponden estos animales."); return; }
      if (!numerosTexto) { alert("Cargá al menos un número de caravana."); return; }
      const r = registrarAnimalesDeCompra(ganadoMovId, numerosTexto);
      if (r.error) { alert(r.error); return; }
      let msg = `Se registraron ${r.creados} animal(es) con su número de caravana (costo de compra: ${fmtMoney2(r.costoUnitario)}/cabeza).`;
      if (r.omitidos.length) msg += `\nOmitidos por ya existir: ${r.omitidos.join(", ")}.`;
      alert(msg);
      renderGanado(root);
    });

    mountCrudTable(host.querySelector("#animalesTableHost"), {
      collection: "animales",
      data: () => activos,
      emptyText: "Todavía no subiste tu inventario individual de animales.",
      sortFn: (a,b) => (a.categoria||"").localeCompare(b.categoria||"") || String(a.numero||"").localeCompare(String(b.numero||"")),
      columns: [
        { key: "numero", label: "Número / Arete", type: "text", required: true },
        { key: "marcaOrigen", label: "Marca de origen (compra)", type: "text", placeholder: "Ej: F, LR, FR, Y…" },
        { key: "categoria", label: "Categoría", type: "select", options: () => STATE.categoriasGanado.map(c=>c.nombre), required: true },
        { key: "colorArete", label: "Color de arete", type: "textlist", options: ["Verde","Amarillo"] },
        { key: "sexo", label: "Sexo", type: "select", options: ["H","M"] },
        { key: "pesoKg", label: "Peso (kg)", type: "number", step: "0.1", numeric: true },
        { key: "fechaNacimiento", label: "Fecha nacimiento", type: "date" },
        { key: "potrero", label: "Potrero / Lote", type: "text" },
        { key: "estado", label: "Estado", type: "select", options: ["ACTIVO","VENDIDO","MUERTO"], default: "ACTIVO" },
        { key: "costoCompra", label: "Costo de compra (Bs/cab)", type: "number", step: "0.01", numeric: true },
        { key: "observaciones", label: "Observaciones", type: "text" }
      ],
      formatCell: (row, col) => col.key === "costoCompra" ? (row.costoCompra != null && row.costoCompra !== "" ? fmtMoney2(row.costoCompra) : "—") : escapeHtml(row[col.key]),
      onAfterChange: () => renderGanado(root)
    });
  } else {
    // Bajas y Salidas — animales que ya no están activos (vendidos o muertos).
    // Quedan acá afuera del Inventario Individual para no mezclarlos con el rodeo vigente,
    // pero siguen editables/borrables por si hay que corregir un estado cargado por error.
    // Cada animal vendido se puede vincular a la venta (Ganado→Movimientos) a la que
    // perteneció, para poder calcular la rentabilidad real de esa venta más abajo.
    const bajas = STATE.animales.filter(a => (a.estado||"ACTIVO").toUpperCase() !== "ACTIVO");
    const rentabilidad = calcRentabilidadVentas(STATE);
    host.innerHTML = `
      <div class="note">Acá quedan los animales que salieron del rodeo (vendidos o muertos) — no se mezclan con el <b>Inventario Individual</b>, que muestra solo los activos. Si marcaste un animal como VENDIDO o MUERTO por error, lo podés editar acá y volver a ponerlo en ACTIVO para que reaparezca en el inventario. Vinculá cada animal vendido a la <b>Venta</b> correspondiente (columna de la tabla) para que la rentabilidad de abajo se calcule con los animales exactos de cada venta.</div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card kpi"><span class="kpi-label">Vendidos</span><span class="kpi-value">${fmtNum(bajas.filter(a=>(a.estado||"").toUpperCase()==="VENDIDO").length)}</span></div>
        <div class="card kpi"><span class="kpi-label">Muertos</span><span class="kpi-value">${fmtNum(bajas.filter(a=>(a.estado||"").toUpperCase()==="MUERTO").length)}</span></div>
      </div>
      <div class="card tight" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">Vincular en bloque a una venta</div>
        <div class="note">Para vender animales que ya diste de baja antes (por ejemplo, al importar tu planilla ya los marcaste VENDIDO): primero cargá la venta en <b>Ganado → Movimientos</b> (SALIDA, con el precio real), y después vinculá acá de una sola vez a todos los animales de esa categoría que estén VENDIDO y todavía sin venta asignada — así no hace falta editarlos uno por uno, y el stock no se descuenta dos veces.</div>
        <div class="grid cols-3">
          <div class="field">
            <label>Categoría</label>
            <select id="bulkVinculoCategoria">
              <option value="">Elegí categoría…</option>
              ${STATE.categoriasGanado.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Venta (SALIDA en Ganado → Movimientos)</label>
            <select id="bulkVinculoVenta">
              <option value="">Elegí una categoría primero…</option>
            </select>
          </div>
          <div class="field" style="justify-content:flex-end">
            <button class="btn" id="btnBulkVincular" type="button" disabled>Vincular</button>
          </div>
        </div>
        <div id="bulkVinculoInfo" style="margin-top:8px;color:#555;font-size:13px"></div>
      </div>
      <div id="bajasTableHost"></div>
      <div class="section-title" style="margin-top:26px">Rentabilidad por venta</div>
      <div class="note">Si los animales de una venta se numeraron al comprarlos (columna "Costo de compra" en Inventario Individual), el costo se calcula con ese valor REAL por animal (✓ costo real). Si no, se estima con el <b>Precio (Bs/cab)</b> promedio de esa categoría cargado en <b>Levantamiento (CREA)</b> — si todavía no lo cargaste, la rentabilidad va a aparecer igual al monto de venta completo (costo Bs 0), así que cargá ese precio primero para que el número sea real.</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Categoría</th><th>Comprador / Destino</th><th class="num">Cabezas vinculadas</th><th class="num">Monto venta</th><th class="num">Costo animales</th><th class="num">Flete</th><th class="num">Costo total</th><th class="num">Rentabilidad</th><th class="num">Rentab. unitaria</th></tr></thead>
        <tbody>
          ${rentabilidad.length ? rentabilidad.map(r => `
            <tr>
              <td>${fmtDate(r.fecha)}</td>
              <td>${escapeHtml(r.categoria)}</td>
              <td>${escapeHtml(r.comprador || r.destino || "—")}</td>
              <td class="num">${fmtNum(r.cabezasVinculadas)}${r.cabezasVinculadas !== r.cabezasMovimiento ? ` <span style="color:#b5332a">(de ${fmtNum(r.cabezasMovimiento)})</span>` : ""}</td>
              <td class="num">${fmtMoney2(r.montoVenta)}</td>
              <td class="num">${fmtMoney2(r.costoAnimales)}${r.sinCostoCargado ? " ⚠️" : (r.usaCostoReal ? ` <span style="color:#2e7d32" title="${r.animalesConCostoReal} de ${r.cabezas} animal(es) con costo real de compra">✓ costo real</span>` : "")}</td>
              <td class="num">${fmtMoney2(r.fleteTotal)}</td>
              <td class="num">${fmtMoney2(r.costoTotal)}</td>
              <td class="num" style="${r.rentabilidad<0?'color:#b5332a;font-weight:700':''}">${fmtMoney2(r.rentabilidad)}</td>
              <td class="num">${fmtMoney2(r.rentabilidadUnitaria)}</td>
            </tr>`).join("") : `<tr><td colspan="10" style="text-align:center;color:#777">Todavía no hay ventas de ganado registradas.</td></tr>`}
        </tbody>
      </table></div>
    `;
    mountCrudTable(host.querySelector("#bajasTableHost"), {
      collection: "animales",
      data: () => bajas,
      noAddForm: true,
      emptyText: "Todavía no hay animales dados de baja (vendidos o muertos).",
      sortFn: (a,b) => (a.categoria||"").localeCompare(b.categoria||"") || String(a.numero||"").localeCompare(String(b.numero||"")),
      columns: [
        { key: "numero", label: "Número / Arete", type: "text", required: true },
        { key: "marcaOrigen", label: "Marca de origen (compra)", type: "text" },
        { key: "categoria", label: "Categoría", type: "select", options: () => STATE.categoriasGanado.map(c=>c.nombre), required: true },
        { key: "colorArete", label: "Color de arete", type: "textlist", options: ["Verde","Amarillo"] },
        { key: "sexo", label: "Sexo", type: "select", options: ["H","M"] },
        { key: "estado", label: "Estado", type: "select", options: ["ACTIVO","VENDIDO","MUERTO"], default: "VENDIDO" },
        { key: "costoCompra", label: "Costo de compra (Bs/cab)", type: "number", step: "0.01", numeric: true },
        { key: "ventaId", label: "Venta", type: "select", options: () => STATE.ganadoMovimiento.filter(m=>m.tipo==="SALIDA").map(m => ({ value: m.id, label: `${fmtDate(m.fecha)} · ${m.categoria} · ${m.comprador||m.destino||"venta"}` })) },
        { key: "observaciones", label: "Observaciones", type: "text" }
      ],
      formatCell: (row, col) => {
        if (col.key === "ventaId") {
          const m = STATE.ganadoMovimiento.find(x => x.id === row.ventaId);
          return m ? escapeHtml(`${fmtDate(m.fecha)} · ${m.comprador||m.destino||"venta"}`) : "—";
        }
        if (col.key === "costoCompra") return row.costoCompra != null && row.costoCompra !== "" ? fmtMoney2(row.costoCompra) : "—";
        return escapeHtml(row[col.key]);
      },
      onAfterChange: () => renderGanado(root)
    });

    const bulkCatSel = host.querySelector("#bulkVinculoCategoria");
    const bulkVentaSel = host.querySelector("#bulkVinculoVenta");
    const bulkBtn = host.querySelector("#btnBulkVincular");
    const bulkInfo = host.querySelector("#bulkVinculoInfo");
    function candidatosBulk() {
      const cat = bulkCatSel.value;
      if (!cat) return [];
      return bajas.filter(a => (a.categoria || "") === cat && (a.estado || "").toUpperCase() === "VENDIDO" && !a.ventaId);
    }
    function actualizarBulkVentaOptions() {
      const cat = bulkCatSel.value;
      const ventas = STATE.ganadoMovimiento.filter(m => m.tipo === "SALIDA" && (m.categoria || "") === cat);
      bulkVentaSel.innerHTML = `<option value="">Elegí venta…</option>` + ventas.map(m => `<option value="${m.id}">${fmtDate(m.fecha)} · ${escapeHtml(m.comprador || m.destino || "venta")} · ${fmtNum(m.cabezas)} cab.</option>`).join("");
      bulkVentaSel.disabled = !cat;
    }
    function actualizarBulkInfo() {
      const cat = bulkCatSel.value;
      const ventaId = bulkVentaSel.value;
      const candidatos = candidatosBulk();
      bulkBtn.disabled = !cat || !ventaId || !candidatos.length;
      if (!cat) { bulkInfo.textContent = ""; return; }
      bulkInfo.textContent = candidatos.length
        ? `Hay ${candidatos.length} animal(es) "${cat}" VENDIDO sin venta asignada, listos para vincular.`
        : `No hay animales "${cat}" VENDIDO sin venta asignada.`;
    }
    bulkCatSel.addEventListener("change", () => { actualizarBulkVentaOptions(); actualizarBulkInfo(); });
    bulkVentaSel.addEventListener("change", actualizarBulkInfo);
    bulkBtn.addEventListener("click", () => {
      const candidatos = candidatosBulk();
      const ventaId = bulkVentaSel.value;
      if (!candidatos.length || !ventaId) return;
      const m = STATE.ganadoMovimiento.find(x => x.id === ventaId);
      if (!confirm(`¿Vincular ${candidatos.length} animal(es) a la venta del ${fmtDate(m.fecha)} (${m.comprador || m.destino || "venta"})?`)) return;
      candidatos.forEach(a => crudUpdate("animales", a.id, { ventaId }));
      renderGanado(root);
    });
    actualizarBulkInfo();
  }
}

/* ==========================================================================
   PERSONAL (sueldos config + planilla individual)
   ========================================================================== */
function renderPersonal(root) {
  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="sueldos">Sueldos (configuración)</button>
      <button class="tab-btn" data-tab="planilla">Planilla individual (adelantos/consumo)</button>
    </div>
    <div id="personalContent"></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => {
    if (b.dataset.tab === uiState.personalTab) b.classList.add("active");
    b.addEventListener("click", () => { uiState.personalTab = b.dataset.tab; renderPersonal(root); });
  });
  const host = root.querySelector("#personalContent");

  if (uiState.personalTab === "sueldos") {
    const s = calcSueldos(STATE);
    host.innerHTML = `
      <div class="note">Cargá el haber básico y el bono de cada funcionario. El aporte patronal (AFP + riesgos) se aplica automáticamente. El <b>Costo anual proyectado</b> ya prorratea por la <b>fecha de ingreso</b> de cada trabajador (mes de ingreso al día, convención boliviana de mes de 30 días) y prorratea el aguinaldo según los meses realmente trabajados en el año ${STATE.meta.anio} — si dejás la fecha de ingreso vacía, se asume que el trabajador ya estaba desde antes (sin prorrateo).</div>
      <div class="card tight" style="margin-bottom:14px">
        <div class="field" style="max-width:220px">
          <label>% Aporte patronal (AFP + Riesgos)</label>
          <input type="number" step="0.0001" id="aportePatronal" value="${STATE.meta.aportePatronal}">
        </div>
      </div>
      <div id="empleadosTableHost"></div>
      <div class="grid cols-4" style="margin-top:16px">
        <div class="card kpi"><span class="kpi-label">Total mensual (haberes, en régimen)</span><span class="kpi-value">${fmtMoney(s.totalMensual)}</span></div>
        <div class="card kpi"><span class="kpi-label">Aporte patronal total (en régimen)</span><span class="kpi-value">${fmtMoney(s.totalAporte)}</span></div>
        <div class="card kpi"><span class="kpi-label">Aguinaldo proyectado ${STATE.meta.anio} (prorrateado)</span><span class="kpi-value">${fmtMoney(s.totalAguinaldoAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Costo anual proyectado ${STATE.meta.anio} (prorrateado)</span><span class="kpi-value">${fmtMoney(s.totalCostoAnual)}</span></div>
      </div>
    `;
    host.querySelector("#aportePatronal").addEventListener("change", e => {
      STATE.meta.aportePatronal = Number(e.target.value) || 0;
      saveState();
      renderPersonal(root);
    });
    mountCrudTable(host.querySelector("#empleadosTableHost"), {
      collection: "empleados",
      emptyText: "Sin empleados cargados.",
      columns: [
        { key: "cargo", label: "Cargo / Funcionario", type: "text", required: true },
        { key: "fechaIngreso", label: "Fecha de ingreso", type: "date" },
        { key: "cantidad", label: "Cant.", type: "number", step: "1", numeric: true, default: 1 },
        { key: "haberBasico", label: "Haber básico (Bs)", type: "number", step: "0.01", numeric: true },
        { key: "bonoProd", label: "Bono producción (Bs)", type: "number", step: "0.01", numeric: true }
      ],
      extraColumns: [
        { label: "Costo total mes", numeric: true, render: row => {
          const cant = Number(row.cantidad)||0, hb = Number(row.haberBasico)||0, bono = Number(row.bonoProd)||0;
          const totalMensual = cant*(hb+bono), aporte = cant*hb*(STATE.meta.aportePatronal||0);
          return fmtMoney2(totalMensual+aporte);
        }},
        { label: `Meses trab. ${STATE.meta.anio}`, numeric: true, render: row => {
          const f = s.filas.find(x => x.id === row.id);
          return f ? fmtNum(f.mesesTrabajados) : "—";
        }},
        { label: `Costo anual ${STATE.meta.anio} (prorrateado)`, numeric: true, render: row => {
          const f = s.filas.find(x => x.id === row.id);
          return f ? fmtMoney2(f.costoAnual) : "—";
        }}
      ],
      formatCell: (row, col) => (["haberBasico","bonoProd"].includes(col.key)) ? fmtMoney2(row[col.key]) : escapeHtml(row[col.key]),
      onAfterChange: () => renderPersonal(root)
    });
  } else {
    // Planilla individual
    if (!uiState.personalWorkerId && STATE.empleados[0]) uiState.personalWorkerId = STATE.empleados[0].id;
    const worker = STATE.empleados.find(e => e.id === uiState.personalWorkerId);
    host.innerHTML = `
      <div class="worker-pills">
        ${STATE.empleados.map(e => `<button data-id="${e.id}" class="${e.id===uiState.personalWorkerId?'active':''}">${escapeHtml(e.cargo)}</button>`).join("")}
      </div>
      <div id="workerHost"></div>
    `;
    host.querySelectorAll(".worker-pills button").forEach(b => {
      b.addEventListener("click", () => { uiState.personalWorkerId = b.dataset.id; renderPersonal(root); });
    });
    const wHost = host.querySelector("#workerHost");
    if (!worker) { wHost.innerHTML = `<div class="empty-state">Agregá empleados en la pestaña Sueldos primero.</div>`; return; }

    const movs = STATE.personalMovimientos.filter(m => m.empleadoId === worker.id);
    const sueldoMes = (Number(worker.cantidad)||0)*((Number(worker.haberBasico)||0)+(Number(worker.bonoProd)||0));
    const totalAdelantos = sum(movs.map(m=>m.adelanto));
    const totalUtensilios = sum(movs.map(m=>m.utensilios));
    const totalConsumo = sum(movs.map(m=>m.consumo));
    const totalDescuentos = totalAdelantos+totalUtensilios+totalConsumo;

    // Haber acumulado desde su fecha de ingreso hasta hoy: suma mes a mes (solo el
    // primer sueldo se prorratea por día para nivelarlo al día 1 del mes siguiente;
    // cada mes posterior ya arrancado cuenta completo desde su día 1). Sin fecha de
    // ingreso cargada no hay desde cuándo sumar, así que se avisa en vez de inventar.
    const haberAcumulado = haberAcumuladoDesdeIngreso(sueldoMes, worker.fechaIngreso, hoyISO());
    const netoAcumulado = haberAcumulado != null ? haberAcumulado - totalDescuentos : null;

    if (!uiState.personalDesde) uiState.personalDesde = primerDiaMesISO();
    if (!uiState.personalHasta) uiState.personalHasta = hoyISO();

    wHost.innerHTML = `
      ${!worker.fechaIngreso ? `<div class="note" style="margin-bottom:14px">⚠️ Este trabajador no tiene <b>fecha de ingreso</b> cargada — sin eso no se puede calcular cuánto se le debe acumulado desde que entró. Cargala en <b>Personal → Sueldos (configuración)</b>.</div>` : ""}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card kpi"><span class="kpi-label">Haber acumulado (desde ingreso${worker.fechaIngreso ? ` ${fmtDate(worker.fechaIngreso)}` : ""})</span><span class="kpi-value">${haberAcumulado != null ? fmtMoney2(haberAcumulado) : "—"}</span></div>
        <div class="card kpi"><span class="kpi-label">Total descuentos (adelantos/víveres/utensilios)</span><span class="kpi-value neg">${fmtMoney2(totalDescuentos)}</span></div>
        <div class="card kpi"><span class="kpi-label">Total adeudado a la fecha</span><span class="kpi-value pos">${netoAcumulado != null ? fmtMoney2(netoAcumulado) : "—"}</span></div>
        <div class="card kpi"><span class="kpi-label">Registros cargados</span><span class="kpi-value">${movs.length}</span></div>
      </div>
      <div class="card tight" style="margin-bottom:16px">
        <div class="form-grid" style="align-items:end">
          <div class="field"><label>Desde</label><input type="date" id="planDesde" value="${uiState.personalDesde}"></div>
          <div class="field"><label>Hasta</label><input type="date" id="planHasta" value="${uiState.personalHasta}"></div>
          <div><button class="btn secondary" id="btnImprimirPlanilla">🖨️ Imprimir planilla (debe y haber)</button></div>
          <div><button class="btn secondary" id="btnDescargarPDF">📄 Descargar PDF</button></div>
        </div>
        <div class="note" style="margin:10px 0 0">La planilla toma el sueldo mensual configurado y solo los adelantos/consumos con fecha dentro del rango elegido. "Descargar PDF" genera el archivo directo, listo para imprimir o enviar.</div>
      </div>
      <div id="movTableHost"></div>
    `;
    wHost.querySelector("#planDesde").addEventListener("change", e => { uiState.personalDesde = e.target.value; });
    wHost.querySelector("#planHasta").addEventListener("change", e => { uiState.personalHasta = e.target.value; });
    wHost.querySelector("#btnImprimirPlanilla").addEventListener("click", () => {
      const desde = wHost.querySelector("#planDesde").value;
      const hasta = wHost.querySelector("#planHasta").value;
      const movsPeriodo = STATE.personalMovimientos
        .filter(m => m.empleadoId === worker.id && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta))
        .sort((a,b) => (a.fecha||"").localeCompare(b.fecha||""));
      imprimirFichaPlanilla(buildFichaPlanillaHTML(worker, movsPeriodo, desde, hasta));
    });
    wHost.querySelector("#btnDescargarPDF").addEventListener("click", (ev) => {
      const desde = wHost.querySelector("#planDesde").value;
      const hasta = wHost.querySelector("#planHasta").value;
      const movsPeriodo = STATE.personalMovimientos
        .filter(m => m.empleadoId === worker.id && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta))
        .sort((a,b) => (a.fecha||"").localeCompare(b.fecha||""));
      descargarFichaPlanillaPDF(worker, buildFichaPlanillaHTML(worker, movsPeriodo, desde, hasta), desde, hasta, ev.target);
    });

    mountCrudTable(wHost.querySelector("#movTableHost"), {
      collection: "personalMovimientos",
      data: () => STATE.personalMovimientos.filter(m => m.empleadoId === worker.id),
      emptyText: "Sin adelantos ni consumos registrados este período.",
      sortFn: (a,b) => (b.fecha||"").localeCompare(a.fecha||""),
      columns: [
        { key: "fecha", label: "Fecha", type: "date", required: true },
        { key: "concepto", label: "Concepto / Detalle", type: "text" },
        { key: "adelanto", label: "Adelanto (Bs)", type: "number", step: "0.01", numeric: true },
        { key: "utensilios", label: "Utensilios (Bs)", type: "number", step: "0.01", numeric: true },
        { key: "consumo", label: "Consumo (Bs)", type: "number", step: "0.01", numeric: true },
        { key: "observacion", label: "Observación", type: "text" },
        { key: "numeroComprobante", label: "Nº comprobante", type: "text" },
        { key: "beneficiario", label: "Beneficiario", type: "text" },
        { key: "comprobante", label: "Comprobante", type: "image" }
      ],
      formatCell: (row, col) => (["adelanto","utensilios","consumo"].includes(col.key)) ? fmtMoney2(row[col.key]) : escapeHtml(row[col.key]),
      footer: rows => `<tr><td colspan="2">Totales</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.adelanto)))}</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.utensilios)))}</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.consumo)))}</td><td></td><td></td><td></td><td></td></tr>`,
      fixedValues: () => ({ empleadoId: worker.id }),
      onAfterChange: () => renderPersonal(root)
    });
  }
}

/* ---------------------------- Planilla imprimible (Debe y Haber) ---------------------------- */
function hoyISO() { return new Date().toISOString().slice(0, 10); }
function primerDiaMesISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
}

function buildFichaPlanillaHTML(worker, movsPeriodo, desde, hasta) {
  // Nota: el bono de producción NO se muestra ni se suma en esta planilla impresa
  // (a pedido del usuario) — el trabajador cobra y firma acá solo por su haber básico.
  // El bono sigue existiendo en el sistema (Personal → Sueldos) para otros reportes
  // como el Estado de Resultados, solo se excluyó de este recibo en particular.
  const cant = Number(worker.cantidad) || 0;
  const hb = Number(worker.haberBasico) || 0;
  // Desglosa el haber básico mes a mes (cuándo se devengó cada sueldo), para que
  // la planilla se lea como un recibo de sueldos real y no solo un total del
  // período. Cada renglón ya viene prorrateado según la fecha de ingreso del
  // trabajador y los límites del período impreso (desde/hasta) — ver
  // desglosarHaberPorMes en calc.js (usa la misma convención de mes de 30 días
  // que haberProrrateado).
  const desgloseHaber = desglosarHaberPorMes(hb, worker.fechaIngreso, desde, hasta);
  const totalHaber = cant * round2(sum(desgloseHaber.map(f => f.monto)));
  const totalAdelantos = sum(movsPeriodo.map(m => m.adelanto));
  const totalUtensilios = sum(movsPeriodo.map(m => m.utensilios));
  const totalConsumo = sum(movsPeriodo.map(m => m.consumo));
  const totalDebe = totalAdelantos + totalUtensilios + totalConsumo;
  const neto = totalHaber - totalDebe;
  const hoy = new Date().toLocaleDateString("es-BO");

  return `
    <div class="ficha">
      <div class="ficha-header">
        <div class="ficha-header-brand">
          <img src="assets/logo.png" alt="Logo" class="ficha-logo">
          <h2>${escapeHtml(STATE.meta.nombreEstancia)}</h2>
        </div>
        <h3>Planilla de Debe y Haber</h3>
        <p><b>Trabajador:</b> ${escapeHtml(worker.cargo)} &nbsp;|&nbsp; <b>Período:</b> ${desde || "—"} al ${hasta || "—"} &nbsp;|&nbsp; <b>Emitido:</b> ${hoy}</p>
      </div>

      <table class="ficha-table">
        <thead>
          <tr><th colspan="3">HABER — Sueldo devengado por mes</th></tr>
          <tr><th>Mes</th><th>Período cubierto</th><th class="num">Importe (x${cant})</th></tr>
        </thead>
        <tbody>
          ${desgloseHaber.length ? desgloseHaber.map(f => `<tr>
              <td>Haber básico — ${escapeHtml(f.mesLabel)}</td>
              <td>${fmtDate(f.desde)} al ${fmtDate(f.hasta)}${f.prorrateado ? ` <span style="color:#777">(prorrateado, ingreso ${escapeHtml(worker.fechaIngreso)})</span>` : ""}</td>
              <td class="num">${fmtMoney2(cant * f.monto)}</td>
            </tr>`).join("") : `<tr><td colspan="3" style="text-align:center;color:#777">Sin haber devengado en este período</td></tr>`}
        </tbody>
        <tfoot><tr><td colspan="2">TOTAL HABER</td><td class="num">${fmtMoney2(totalHaber)}</td></tr></tfoot>
      </table>

      <table class="ficha-table">
        <thead>
          <tr><th colspan="7">DEBE — Adelantos y consumos del período</th></tr>
          <tr><th>Fecha</th><th>Concepto</th><th class="num">Adelanto</th><th class="num">Víveres/Pedidos</th><th class="num">Utensilios</th><th>Nº Comprobante</th><th>Foto</th></tr>
        </thead>
        <tbody>
          ${movsPeriodo.length ? movsPeriodo.map(m => `<tr>
              <td>${fmtDate(m.fecha)}</td>
              <td>${escapeHtml(m.concepto || "")}</td>
              <td class="num">${(Number(m.adelanto)||0) ? fmtMoney2(m.adelanto) : "—"}</td>
              <td class="num">${(Number(m.consumo)||0) ? fmtMoney2(m.consumo) : "—"}</td>
              <td class="num">${(Number(m.utensilios)||0) ? fmtMoney2(m.utensilios) : "—"}</td>
              <td>${escapeHtml(m.numeroComprobante || "—")}</td>
              <td>${m.comprobante ? `<img src="${m.comprobante}" class="ficha-thumb">` : "—"}</td>
            </tr>`).join("") : `<tr><td colspan="7" style="text-align:center;color:#777">Sin movimientos en este período</td></tr>`}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Subtotales</td>
            <td class="num">${fmtMoney2(totalAdelantos)}</td>
            <td class="num">${fmtMoney2(totalConsumo)}</td>
            <td class="num">${fmtMoney2(totalUtensilios)}</td>
            <td></td>
          </tr>
          <tr><td colspan="5">TOTAL DEBE</td><td class="num">${fmtMoney2(totalDebe)}</td></tr>
        </tfoot>
      </table>

      <table class="ficha-table ficha-neto">
        <tbody><tr><td>NETO A PAGAR (Haber − Debe)</td><td class="num">${fmtMoney2(neto)}</td></tr></tbody>
      </table>

      <div class="ficha-firmas">
        <div class="firma-box">_________________________<br>Firma Empleador</div>
        <div class="firma-box">_________________________<br>Firma Trabajador</div>
      </div>
    </div>
  `;
}

function imprimirFichaPlanilla(html) {
  let printArea = document.getElementById("printArea");
  if (!printArea) {
    printArea = document.createElement("div");
    printArea.id = "printArea";
    document.body.appendChild(printArea);
  }
  printArea.innerHTML = html;
  window.print();
}

// Nombre de archivo seguro (sin tildes/símbolos raros) para la planilla en PDF,
// ej. "Planilla_Capataz_2026-07-01_a_2026-07-15.pdf".
function nombreArchivoPlanillaPDF(worker, desde, hasta) {
  const normalizar = s => String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const cargo = normalizar(worker.cargo) || "Trabajador";
  const rango = `${desde || "inicio"}_a_${hasta || "hoy"}`;
  return `Planilla_${cargo}_${rango}.pdf`;
}

/**
 * Genera y descarga la planilla (el mismo HTML de debe/haber que arma
 * buildFichaPlanillaHTML para "Imprimir") como archivo PDF, usando html2pdf.js
 * (html2canvas + jsPDF) cargado desde CDN en index.html. La muestra un
 * instante como overlay a pantalla completa (necesario para que html2canvas
 * la capture bien) y la oculta de nuevo apenas termina la descarga.
 */
function descargarFichaPlanillaPDF(worker, html, desde, hasta, botonOrigen) {
  if (typeof html2pdf === "undefined") {
    alert("No se pudo cargar el generador de PDF (revisá tu conexión a internet e intentá de nuevo).");
    return;
  }
  let pdfArea = document.getElementById("pdfArea");
  if (!pdfArea) {
    pdfArea = document.createElement("div");
    pdfArea.id = "pdfArea";
    document.body.appendChild(pdfArea);
  }
  // Se muestra tapando toda la pantalla (fondo blanco) mientras se genera el
  // PDF — es exactamente el mismo HTML que la planilla de "Imprimir", así que
  // el PDF descargado sale igual. IMPORTANTE: html2canvas necesita que el
  // elemento esté realmente visible para poder capturarlo; escondiéndolo con
  // "left:-9999px" (como estaba antes) o con "display:none" (heredado del
  // CSS por defecto) el PDF salía en blanco. Además, html2canvas tiene un bug
  // conocido con "position:fixed": si la página está scrolleada al momento de
  // capturar (lo normal, porque el botón está más abajo), calcula mal el
  // recorte y también sale en blanco. Por eso forzamos scroll a 0,0 ANTES de
  // mostrar el overlay, y usamos scrollX/scrollY:0 en html2canvas como
  // refuerzo. Se oculta de nuevo apenas termina de descargar.
  window.scrollTo(0, 0);
  pdfArea.style.cssText = "display:block;position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto;padding:24px;box-sizing:border-box;";
  pdfArea.innerHTML = html;

  const textoOriginal = botonOrigen ? botonOrigen.textContent : null;
  if (botonOrigen) { botonOrigen.disabled = true; botonOrigen.textContent = "Generando PDF…"; }

  const ocultarPdfArea = () => {
    pdfArea.style.cssText = "display:none;";
    pdfArea.innerHTML = "";
    if (botonOrigen) { botonOrigen.disabled = false; botonOrigen.textContent = textoOriginal; }
  };

  // Esperamos al próximo frame para asegurarnos de que el navegador ya
  // aplicó el scroll a 0,0 y el reflow del overlay antes de que html2canvas
  // empiece a clonar el DOM (si captura en el mismo tick, a veces agarra
  // coordenadas viejas y sale en blanco).
  requestAnimationFrame(() => {
    html2pdf().set({
      margin: 10,
      filename: nombreArchivoPlanillaPDF(worker, desde, hasta),
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0, windowWidth: document.documentElement.clientWidth, windowHeight: document.documentElement.clientHeight },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["avoid-all", "css", "legacy"] }
    }).from(pdfArea).save().then(ocultarPdfArea).catch(err => {
      console.error("Error generando PDF:", err);
      alert("No se pudo generar el PDF. Probá de nuevo, o usá '🖨️ Imprimir planilla' y elegí 'Guardar como PDF' desde el diálogo de impresión.");
      ocultarPdfArea();
    });
  });
}

/* ==========================================================================
   GASTOS FIJOS
   ========================================================================== */
function renderGastosFijos(root) {
  root.innerHTML = `<div class="note">Gastos que pagás todos los meses, más o menos por el mismo importe (arriendo, seguros, servicios).</div><div id="gfHost"></div><div id="gfTotales" class="grid cols-2" style="margin-top:16px"></div>`;
  mountCrudTable(root.querySelector("#gfHost"), {
    collection: "gastosFijos",
    emptyText: "Sin gastos fijos cargados.",
    columns: [
      { key: "concepto", label: "Concepto", type: "text", required: true },
      { key: "importeMensual", label: "Importe mensual (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "observaciones", label: "Observaciones", type: "text" }
    ],
    extraColumns: [ { label: "Importe anual", numeric: true, render: row => fmtMoney2((Number(row.importeMensual)||0)*12) } ],
    formatCell: (row, col) => col.key === "importeMensual" ? fmtMoney2(row.importeMensual) : escapeHtml(row[col.key]),
    footer: rows => `<tr><td>TOTAL</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.importeMensual)))}</td><td></td><td class="num">${fmtMoney2(sum(rows.map(r=>r.importeMensual))*12)}</td></tr>`,
    onAfterChange: () => renderGastosFijos(root)
  });
  const gf = calcGastosFijos(STATE);
  root.querySelector("#gfTotales").innerHTML = `
    <div class="card kpi"><span class="kpi-label">Total mensual</span><span class="kpi-value">${fmtMoney(gf.totalMensual)}</span></div>
    <div class="card kpi"><span class="kpi-label">Total anual</span><span class="kpi-value">${fmtMoney(gf.totalAnual)}</span></div>
  `;
}

/* ==========================================================================
   GASTOS VARIABLES
   ========================================================================== */
function renderGastosVariables(root) {
  root.innerHTML = `<div class="note">Tabla de referencia (presupuesto) por consumo estimado. Los gastos reales del mes se cargan en <b>Diario</b>.</div><div id="gvHost"></div><div id="gvTotales" class="grid cols-2" style="margin-top:16px"></div>`;
  mountCrudTable(root.querySelector("#gvHost"), {
    collection: "gastosVariables",
    emptyText: "Sin gastos variables cargados.",
    sortFn: (a,b) => (a.seccion||"").localeCompare(b.seccion||""),
    columns: [
      { key: "seccion", label: "Sección", type: "text", required: true },
      { key: "concepto", label: "Concepto", type: "text", required: true },
      { key: "unidad", label: "Unidad", type: "text" },
      { key: "cantidadMes", label: "Cantidad/mes", type: "number", step: "0.01", numeric: true },
      { key: "precioUnit", label: "P. Unit. (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "observaciones", label: "Observaciones", type: "text" }
    ],
    extraColumns: [ { label: "Importe mes", numeric: true, render: row => fmtMoney2((Number(row.cantidadMes)||0)*(Number(row.precioUnit)||0)) } ],
    formatCell: (row, col) => col.key === "precioUnit" ? fmtMoney2(row.precioUnit) : escapeHtml(row[col.key]),
    footer: rows => `<tr><td colspan="5">TOTAL</td><td class="num">${fmtMoney2(sum(rows.map(r=>(Number(r.cantidadMes)||0)*(Number(r.precioUnit)||0))))}</td></tr>`,
    onAfterChange: () => renderGastosVariables(root)
  });
  const gv = calcGastosVariables(STATE);
  root.querySelector("#gvTotales").innerHTML = `<div class="card kpi"><span class="kpi-label">Total mensual estimado</span><span class="kpi-value">${fmtMoney(gv.total)}</span></div>`;
}

/* ==========================================================================
   FINANCIERO (Estado de Resultados / Flujo de Caja / Balance)
   ========================================================================== */
function tableMensual(titulo, filas, totalRow) {
  return `
    <div class="table-wrap" style="margin-bottom:18px">
      <table>
        <thead><tr><th>${titulo}</th>${MESES_LABEL.map(m=>`<th class="num">${m}</th>`).join("")}<th class="num">Total año</th></tr></thead>
        <tbody>
          ${filas.map(f => `<tr><td>${f.nombre}</td>${f.valores.map(v=>`<td class="num">${fmtMoney(v)}</td>`).join("")}<td class="num">${fmtMoney(sum(f.valores))}</td></tr>`).join("")}
        </tbody>
        ${totalRow ? `<tfoot><tr><td>${totalRow.nombre}</td>${totalRow.valores.map(v=>`<td class="num">${fmtMoney(v)}</td>`).join("")}<td class="num">${fmtMoney(totalRow.total!=null?totalRow.total:sum(totalRow.valores))}</td></tr></tfoot>` : ""}
      </table>
    </div>`;
}

function renderFinanciero(root) {
  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="resultado">Estado de Resultados</button>
      <button class="tab-btn" data-tab="flujo">Flujo de Caja</button>
      <button class="tab-btn" data-tab="balance">Balance General</button>
    </div>
    <div id="finContent"></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => {
    if (b.dataset.tab === uiState.financieroTab) b.classList.add("active");
    b.addEventListener("click", () => { uiState.financieroTab = b.dataset.tab; renderFinanciero(root); });
  });
  const host = root.querySelector("#finContent");
  const anio = STATE.meta.anio;

  if (uiState.financieroTab === "resultado") {
    const er = calcEstadoResultado(STATE, anio);
    host.innerHTML = `
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card kpi"><span class="kpi-label">Total ingresos</span><span class="kpi-value">${fmtMoney(er.totalIngresosAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Margen bruto</span><span class="kpi-value">${fmtMoney(er.margenBrutoAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Resultado operativo</span><span class="kpi-value ${er.resultadoAnio>=0?'pos':'neg'}">${fmtMoney(er.resultadoAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Margen neto %</span><span class="kpi-value">${fmtPct(er.margenNetoAnio)}</span></div>
      </div>
      <div class="chart-card" style="margin-bottom:18px"><b>Resultado por mes</b><canvas id="chResultado"></canvas></div>
      ${tableMensual("INGRESOS", [
        {nombre:"Venta de Ganado", valores: er.ventaGanado},
        {nombre:"Venta de Subproductos", valores: er.ventaSubproductos},
        {nombre:"Otros Ingresos", valores: er.otrosIngresos}
      ], {nombre:"TOTAL INGRESOS", valores: er.totalIngresosMes, total: er.totalIngresosAnio})}
      ${tableMensual("COSTOS DIRECTOS", [
        {nombre:"Compra de Ganado", valores: er.compraGanado},
        ...er.costosDirectosDetalle
      ], {nombre:"TOTAL COSTOS DIRECTOS", valores: er.totalCostosDirectosMes})}
      ${tableMensual("MARGEN BRUTO", [], {nombre:"MARGEN BRUTO", valores: er.margenBrutoMes, total: er.margenBrutoAnio})}
      ${tableMensual("COSTOS DE ESTRUCTURA", [
        ...er.estructuraDetalle,
        {nombre:"Depreciación", valores: er.depreciacionMes}
      ], {nombre:"TOTAL ESTRUCTURA", valores: er.totalEstructuraMes})}
      ${tableMensual("RESULTADO", [], {nombre:"RESULTADO OPERATIVO", valores: er.resultadoMes, total: er.resultadoAnio})}
      <div class="note">Variación de inventario de ganado (solo cuenta en el total anual de ingresos): ${fmtMoney(er.variacionInventario)}</div>
    `;
    chartResultadoMensual("chResultado", er);
  } else if (uiState.financieroTab === "flujo") {
    const fl = calcFlujoCaja(STATE, anio);
    host.innerHTML = `
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card kpi"><span class="kpi-label">Saldo inicial</span><span class="kpi-value">${fmtMoney(fl.saldoInicialTotal)}</span></div>
        <div class="card kpi"><span class="kpi-label">Entradas del año</span><span class="kpi-value pos">${fmtMoney(fl.totalEntradasAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Salidas del año</span><span class="kpi-value neg">${fmtMoney(fl.totalSalidasAnio)}</span></div>
        <div class="card kpi"><span class="kpi-label">Saldo final</span><span class="kpi-value ${fl.saldoFinalAnio>=0?'pos':'neg'}">${fmtMoney(fl.saldoFinalAnio)}</span></div>
      </div>
      <div class="chart-card" style="margin-bottom:18px"><b>Evolución del saldo</b><canvas id="chFlujo"></canvas></div>
      ${tableMensual("FLUJO DE CAJA", [
        {nombre:"(+) Entradas de efectivo", valores: fl.entradas},
        {nombre:"(−) Salidas de efectivo", valores: fl.salidas},
        {nombre:"Flujo neto del mes", valores: fl.flujoNeto},
        {nombre:"Saldo final acumulado", valores: fl.saldoFinalAcumulado}
      ])}
      <div class="section-title">Saldo por cuenta (al cierre del año)</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Cuenta</th><th class="num">Saldo inicial</th><th class="num">Ingresos año</th><th class="num">Egresos año</th><th class="num">Saldo final</th></tr></thead>
        <tbody>${fl.porCuenta.map(c=>`<tr><td>${escapeHtml(c.nombre)}</td><td class="num">${fmtMoney2(c.saldoInicial)}</td><td class="num">${fmtMoney2(c.ingresosAnio)}</td><td class="num">${fmtMoney2(c.egresosAnio)}</td><td class="num">${fmtMoney2(c.saldoFinal)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>TOTAL</td><td class="num">${fmtMoney2(sum(fl.porCuenta.map(c=>c.saldoInicial)))}</td><td class="num">${fmtMoney2(sum(fl.porCuenta.map(c=>c.ingresosAnio)))}</td><td class="num">${fmtMoney2(sum(fl.porCuenta.map(c=>c.egresosAnio)))}</td><td class="num">${fmtMoney2(fl.totalPorCuentaFinal)}</td></tr></tfoot>
      </table></div>
    `;
    chartFlujoCaja("chFlujo", fl);
  } else {
    const bal = calcBalance(STATE, anio);
    host.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <div class="section-title">Activos</div>
          <table>
            <tr><td class="muted">Activo corriente</td><td></td></tr>
            <tr><td>Caja / Efectivo</td><td class="num">${fmtMoney2(bal.caja)}</td></tr>
            <tr><td>Banco</td><td class="num">${fmtMoney2(bal.banco)}</td></tr>
            <tr><td>Tarjeta (saldo a favor)</td><td class="num">${fmtMoney2(bal.tarjetaActivo)}</td></tr>
            <tr><td>Inventario de Ganado (venta/engorde — bien de cambio)</td><td class="num">${fmtMoney2(bal.inventarioGanadoVenta)}</td></tr>
            <tr><td><b>Total activo corriente</b></td><td class="num"><b>${fmtMoney2(bal.totalActivoCorriente)}</b></td></tr>
            <tr><td class="muted" style="padding-top:10px">Activo no corriente</td><td></td></tr>
            <tr><td>Tierra / Campo</td><td class="num">${fmtMoney2(bal.tierra)}</td></tr>
            <tr><td>Instalaciones</td><td class="num">${fmtMoney2(bal.instalaciones)}</td></tr>
            <tr><td>Maquinaria y Vehículos</td><td class="num">${fmtMoney2(bal.maquinaria)}</td></tr>
            <tr><td>Otros activos fijos</td><td class="num">${fmtMoney2(bal.otrosAF)}</td></tr>
            <tr><td>Hacienda reproductora (cría — activo biológico)</td><td class="num">${fmtMoney2(bal.inventarioGanadoCria)}</td></tr>
            <tr><td>(−) Depreciación acumulada</td><td class="num">-${fmtMoney2(bal.deprecAcumulada)}</td></tr>
            <tr><td><b>Total activo no corriente</b></td><td class="num"><b>${fmtMoney2(bal.totalActivoNoCorriente)}</b></td></tr>
            <tr><td style="padding-top:8px"><b>TOTAL ACTIVOS</b></td><td class="num" style="padding-top:8px"><b>${fmtMoney2(bal.totalActivos)}</b></td></tr>
          </table>
        </div>
        <div class="card">
          <div class="section-title">Pasivo y Patrimonio</div>
          <table>
            <tr><td class="muted">Pasivos</td><td></td></tr>
            <tr><td>Préstamo bancario</td><td class="num">${fmtMoney2(bal.prestamoBancario)}</td></tr>
            <tr><td>Cuenta proveedores</td><td class="num">${fmtMoney2(bal.cuentaProveedores)}</td></tr>
            <tr><td>Tarjeta por pagar</td><td class="num">${fmtMoney2(bal.tarjetaPasivo)}</td></tr>
            <tr><td>Otros pasivos</td><td class="num">${fmtMoney2(bal.otrosPasivos)}</td></tr>
            <tr><td><b>Total pasivos</b></td><td class="num"><b>${fmtMoney2(bal.totalPasivos)}</b></td></tr>
            <tr><td class="muted" style="padding-top:10px">Patrimonio</td><td></td></tr>
            <tr><td>Capital inicial</td><td class="num">${fmtMoney2(bal.capitalInicial)}</td></tr>
            <tr><td>Aportes del período</td><td class="num">${fmtMoney2(bal.aportesPeriodo)}</td></tr>
            <tr><td>Resultado del ejercicio</td><td class="num">${fmtMoney2(bal.resultadoEjercicio)}</td></tr>
            <tr><td><b>Total patrimonio</b></td><td class="num"><b>${fmtMoney2(bal.totalPatrimonio)}</b></td></tr>
            <tr><td style="padding-top:8px"><b>TOTAL PASIVO + PATRIMONIO</b></td><td class="num" style="padding-top:8px"><b>${fmtMoney2(bal.totalPasivos+bal.totalPatrimonio)}</b></td></tr>
          </table>
        </div>
      </div>
      <div class="alert ${Math.abs(bal.controlCuadre)<0.5?'ok':'bad'}" style="margin-top:14px">Control de cuadre (debe ser 0): ${fmtMoney2(bal.controlCuadre)}</div>
    `;
  }
}

/* ==========================================================================
   ANÁLISIS
   ========================================================================== */
function renderAnalisis(root) {
  const an = calcAnalisis(STATE, STATE.meta.anio);
  root.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><span class="kpi-label">Resultado del ejercicio</span><span class="kpi-value ${an.resultado>=0?'pos':'neg'}">${fmtMoney(an.resultado)}</span><span class="kpi-sub">${an.estado === 'RENTABLE' ? '✔ RENTABLE' : an.estado === 'PÉRDIDA' ? '✖ PÉRDIDA' : 'EQUILIBRIO'}</span></div>
      <div class="card kpi"><span class="kpi-label">Margen bruto %</span><span class="kpi-value">${fmtPct(an.margenBrutoPct)}</span></div>
      <div class="card kpi"><span class="kpi-label">Margen neto %</span><span class="kpi-value">${fmtPct(an.margenNetoPct)}</span></div>
      <div class="card kpi"><span class="kpi-label">Punto de equilibrio (ingresos)</span><span class="kpi-value">${fmtMoney(an.puntoEquilibrio)}</span></div>
      <div class="card kpi"><span class="kpi-label">ROA (rentab. s/ activos)</span><span class="kpi-value">${fmtPct(an.roa)}</span></div>
      <div class="card kpi"><span class="kpi-label">ROE (rentab. s/ patrimonio)</span><span class="kpi-value">${fmtPct(an.roe)}</span></div>
      <div class="card kpi"><span class="kpi-label">Ingresos totales</span><span class="kpi-value">${fmtMoney(an.ingresosTotales)}</span></div>
      <div class="card kpi"><span class="kpi-label">Costos totales</span><span class="kpi-value">${fmtMoney(an.costosTotales)}</span></div>
    </div>

    <div class="section" style="margin-top:20px">
      <div class="section-title">¿Dónde gasto más?</div>
      <div class="grid cols-2">
        <div class="chart-card"><b>Ranking de costos por rubro</b><canvas id="chRubros"></canvas></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Rubro</th><th class="num">Importe año</th><th class="num">% de costos</th></tr></thead>
            <tbody>${an.rubros.map(r=>`<tr><td>${escapeHtml(r.nombre)}</td><td class="num">${fmtMoney2(r.importe)}</td><td class="num">${fmtPct(r.pctTotal)}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </div>
      ${an.mayorCosto ? `<div class="note">Mayor costo del año: <b>${escapeHtml(an.mayorCosto.nombre)}</b> (${fmtPct(an.mayorCosto.pctTotal)} del total)</div>` : ""}
    </div>

    <div class="section">
      <div class="section-title">Indicadores ganaderos</div>
      <div class="grid cols-4">
        <div class="card kpi"><span class="kpi-label">Stock actual (cab.)</span><span class="kpi-value">${fmtNum(an.stockActual)}</span></div>
        <div class="card kpi"><span class="kpi-label">Compradas (año)</span><span class="kpi-value">${fmtNum(an.compradas)}</span></div>
        <div class="card kpi"><span class="kpi-label">Nacimientos (año)</span><span class="kpi-value">${fmtNum(an.nacimientos)}</span></div>
        <div class="card kpi"><span class="kpi-label">Vendidas (año)</span><span class="kpi-value">${fmtNum(an.vendidas)}</span></div>
        <div class="card kpi"><span class="kpi-label">Muertes (año)</span><span class="kpi-value">${fmtNum(an.muertes)}</span></div>
        <div class="card kpi"><span class="kpi-label">Tasa de mortalidad</span><span class="kpi-value ${an.tasaMortalidad>0.03?'neg':'pos'}">${fmtPct(an.tasaMortalidad)}</span></div>
        <div class="card kpi"><span class="kpi-label">Tasa de extracción</span><span class="kpi-value">${fmtPct(an.tasaExtraccion)}</span></div>
        <div class="card kpi"><span class="kpi-label">Costo total por cabeza</span><span class="kpi-value">${fmtMoney(an.costoPorCabeza)}</span></div>
        <div class="card kpi"><span class="kpi-label">Margen bruto ganadero</span><span class="kpi-value">${fmtMoney(an.margenBrutoGanadero)}</span></div>
        <div class="card kpi"><span class="kpi-label">Valor actual del rodeo</span><span class="kpi-value">${fmtMoney(an.valorActualRodeo)}</span></div>
        <div class="card kpi"><span class="kpi-label">Precio prom. venta Kilo Vivo (Bs/kg)</span><span class="kpi-value">${fmtMoney2(an.precioPromVentaKiloVivo)}</span></div>
        <div class="card kpi"><span class="kpi-label">Precio prom. venta Kilo Gancho (Bs/kg)</span><span class="kpi-value">${fmtMoney2(an.precioPromVentaKiloGancho)}</span></div>
        <div class="card kpi"><span class="kpi-label">Vendido Al Bulto (Bs)</span><span class="kpi-value">${fmtMoney(an.totalBsVendidoBulto)}</span><span class="kpi-sub">${fmtNum(an.totalCabezasBulto)} cabezas (precio pactado por lote, sin base en kg)</span></div>
        <div class="card kpi"><span class="kpi-label">Precio prom. compra (Bs/kg)</span><span class="kpi-value">${fmtMoney2(an.precioPromCompra)}</span></div>
        <div class="card kpi"><span class="kpi-label">Carga animal (EV/ha)</span><span class="kpi-value">${fmtNum(an.cargaAnimalEVporHa)}</span></div>
        <div class="card kpi"><span class="kpi-label">Total Equivalente Vaca (EV)</span><span class="kpi-value">${fmtNum(an.totalEV)}</span></div>
      </div>
    </div>
  `;
  chartCostosPorRubro("chRubros", an.rubros);
}

/* ==========================================================================
   CONFIGURACIÓN
   ========================================================================== */
function renderConfiguracion(root) {
  root.innerHTML = `
    <div class="section">
      <div class="section-title">General</div>
      <div class="card form-grid">
        <div class="field"><label>Nombre de la estancia</label><input id="cfgNombre" value="${escapeHtml(STATE.meta.nombreEstancia)}"></div>
        <div class="field"><label>Alerta de caja mínima (Bs)</label><input id="cfgAlertaCaja" type="number" step="0.01" value="${STATE.meta.alertaCajaMin}"></div>
        <div class="field"><label>Superficie ganadera (ha)</label><input id="cfgSuperficie" type="number" step="0.01" value="${STATE.inventarioCrea.superficieHa||0}"></div>
        <div><button class="btn" id="btnGuardarGeneral">Guardar</button></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Cuentas de dinero</div>
      <div id="cuentasHost"></div>
    </div>

    <div class="section">
      <div class="section-title">Categorías del Diario</div>
      <div id="catDiarioHost"></div>
    </div>

    <div class="section">
      <div class="section-title">Categorías de Ganado (método CREA)</div>
      <div id="catGanadoHost"></div>
    </div>

    <div class="section">
      <div class="section-title">Activos fijos iniciales</div>
      <div id="activosHost"></div>
    </div>

    <div class="section">
      <div class="section-title">Pasivos iniciales</div>
      <div class="card form-grid">
        <div class="field"><label>Préstamo bancario (Bs)</label><input id="pasPrestamo" type="number" step="0.01" value="${STATE.pasivosIniciales.prestamoBancario}"></div>
        <div class="field"><label>Cuenta proveedores (Bs)</label><input id="pasProveedores" type="number" step="0.01" value="${STATE.pasivosIniciales.cuentaProveedores}"></div>
        <div class="field"><label>Otros pasivos (Bs)</label><input id="pasOtros" type="number" step="0.01" value="${STATE.pasivosIniciales.otrosPasivos}"></div>
        <div><button class="btn" id="btnGuardarPasivos">Guardar</button></div>
      </div>
    </div>
  `;

  root.querySelector("#btnGuardarGeneral").addEventListener("click", () => {
    STATE.meta.nombreEstancia = root.querySelector("#cfgNombre").value || "Estancia Los Cepes";
    STATE.meta.alertaCajaMin = Number(root.querySelector("#cfgAlertaCaja").value) || 0;
    STATE.inventarioCrea.superficieHa = Number(root.querySelector("#cfgSuperficie").value) || 0;
    saveState();
    actualizarMarcaEnPantalla();
    alert("Guardado.");
  });
  root.querySelector("#btnGuardarPasivos").addEventListener("click", () => {
    STATE.pasivosIniciales.prestamoBancario = Number(root.querySelector("#pasPrestamo").value) || 0;
    STATE.pasivosIniciales.cuentaProveedores = Number(root.querySelector("#pasProveedores").value) || 0;
    STATE.pasivosIniciales.otrosPasivos = Number(root.querySelector("#pasOtros").value) || 0;
    saveState();
    alert("Guardado.");
  });

  mountCrudTable(root.querySelector("#cuentasHost"), {
    collection: "cuentas",
    columns: [
      { key: "nombre", label: "Cuenta", type: "text", required: true },
      { key: "clasificacion", label: "Clasificación", type: "select", options: ["Activo","Pasivo"] },
      { key: "saldoInicial", label: "Saldo inicial (Bs)", type: "number", step: "0.01", numeric: true }
    ],
    formatCell: (row,col) => col.key==='saldoInicial' ? fmtMoney2(row.saldoInicial) : escapeHtml(row[col.key]),
    onAfterChange: () => renderConfiguracion(root)
  });

  mountCrudTable(root.querySelector("#catDiarioHost"), {
    collection: "categoriasDiario",
    columns: [
      { key: "nombre", label: "Categoría", type: "text", required: true },
      { key: "tipo", label: "Tipo", type: "select", options: ["INGRESO","EGRESO"] },
      { key: "grupo", label: "Grupo (Estado de Resultados)", type: "select", options: ["Mano de Obra","Gastos Directos","Estructura","Inversión","Financiación","Ingreso Operativo"] }
    ],
    formatCell: (row,col) => col.key==='tipo' ? `<span class="tag ${row.tipo==='INGRESO'?'ingreso':'egreso'}">${row.tipo}</span>` : escapeHtml(row[col.key]),
    onAfterChange: () => renderConfiguracion(root)
  });

  mountCrudTable(root.querySelector("#catGanadoHost"), {
    collection: "categoriasGanado",
    columns: [
      { key: "nombre", label: "Categoría", type: "text", required: true },
      { key: "coefEV", label: "Coeficiente EV", type: "number", step: "0.01", numeric: true, default: 1 },
      { key: "funcion", label: "Función", type: "select", options: ["Cría (reproductor)","Venta (engorde)"], default: "Venta (engorde)" }
    ],
    onAfterChange: () => renderConfiguracion(root)
  });

  mountCrudTable(root.querySelector("#activosHost"), {
    collection: "activosFijos",
    columns: [
      { key: "concepto", label: "Concepto", type: "text", required: true },
      { key: "valor", label: "Valor (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "vidaUtil", label: "Vida útil (años)", type: "number", step: "1", numeric: true }
    ],
    formatCell: (row,col) => col.key==='valor' ? fmtMoney2(row.valor) : (col.key==='vidaUtil' ? (row.vidaUtil||"no deprecia") : escapeHtml(row[col.key])),
    onAfterChange: () => renderConfiguracion(root)
  });
}

/* ==========================================================================
   DATOS / EXCEL
   ========================================================================== */
function renderDatos(root) {
  root.innerHTML = `
    <div class="section">
      <div class="section-title">Importar desde tu Excel</div>
      <div class="card">
        <p style="margin-top:0;font-size:13.5px">Subí tu archivo <code>Estancia_Ganadera_Costos.xlsx</code> para traer Diario, Ganado, Sueldos y Gastos Fijos a la app. Se agregan a lo que ya tengas cargado (no borra nada).</p>
        <input type="file" id="fileImport" accept=".xlsx,.xls">
        <div id="importResult" style="margin-top:10px;font-size:13px"></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Exportar / Respaldo</div>
      <div class="card datos-actions">
        <button class="btn" id="btnExportExcel">⬇️ Exportar a Excel (.xlsx)</button>
        <button class="btn secondary" id="btnExportJson">⬇️ Exportar copia de seguridad (.json)</button>
        <label class="btn secondary" style="cursor:pointer">⬆️ Restaurar copia de seguridad (.json)
          <input type="file" id="fileJson" accept=".json" style="display:none">
        </label>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Almacenamiento del navegador</div>
      <div class="card" id="storageCard">
        <div id="storageInfo" style="font-size:13.5px;margin-bottom:10px"></div>
        <button class="btn secondary" id="btnPurgeImgs">🧹 Liberar espacio (eliminar fotos de entradas borradas)</button>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Zona de riesgo</div>
      <div class="card">
        <button class="btn danger" id="btnReset">🗑️ Borrar todos los datos de la app</button>
      </div>
    </div>
  `;
  root.querySelector("#fileImport").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const res = document.getElementById("importResult");
    res.textContent = "Importando…";
    try {
      const counts = await importExcelFile(file);
      res.textContent = `Listo: ${counts.diario} filas de Diario, ${counts.ganado} de Ganado, ${counts.empleados} empleados, ${counts.gastosFijos} gastos fijos.`;
    } catch (err) {
      console.error(err);
      res.textContent = "No se pudo leer el archivo. Verificá que sea un .xlsx exportado de este mismo proyecto.";
    }
  });
  root.querySelector("#btnExportExcel").addEventListener("click", () => exportExcelFile());
  root.querySelector("#btnExportJson").addEventListener("click", () => {
    // El STATE en memoria ya tiene las imágenes inyectadas, se exportan completas
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `estancia_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  });
  root.querySelector("#fileJson").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm("Esto reemplaza todos los datos actuales de la app por los del archivo. ¿Continuar?")) return;
    const text = await file.text();
    try {
      STATE = migrateState(JSON.parse(text));
      saveState(); // saveState separa las imágenes automáticamente
      location.reload();
    } catch (err) {
      alert("Archivo inválido.");
    }
  });

  // ── Almacenamiento ──────────────────────────────────────────
  function refreshStorageInfo() {
    const u = storageUsageKB();
    const pct = Math.min(100, Math.round(u.totalKB / 51.2)); // ~5 MB = 5120 KB
    const barColor = pct > 80 ? "#e53e3e" : pct > 55 ? "#ed8936" : "#38a169";
    root.querySelector("#storageInfo").innerHTML = `
      <b>Uso del almacenamiento del navegador</b><br>
      <div style="margin:6px 0 2px;background:#e2e8f0;border-radius:6px;height:10px;overflow:hidden">
        <div style="width:${pct}%;background:${barColor};height:100%;border-radius:6px;transition:width .3s"></div>
      </div>
      <span style="color:#666">Datos: <b>${u.mainKB} KB</b> &nbsp;|&nbsp; Fotos de comprobantes: <b>${u.imgsKB} KB</b> &nbsp;|&nbsp; Total: <b>${u.totalKB} KB</b> de ~5 120 KB disponibles</span>
    `;
  }
  refreshStorageInfo();
  root.querySelector("#btnPurgeImgs").addEventListener("click", () => {
    const n = purgeOrphanImages();
    refreshStorageInfo();
    alert(n > 0 ? `Se liberaron ${n} foto(s) de entradas ya eliminadas.` : "No había fotos huérfanas. El espacio ya estaba optimizado.");
  });
  root.querySelector("#btnReset").addEventListener("click", resetState);
}

/* ==========================================================================
   ALMACÉN
   ========================================================================== */
const ALMACEN_CATEGORIAS_UI = ["Víveres", "Accesorios", "Herramientas", "Sanidad", "Nutrición", "Combustible"];
// Categorías de almacén que se le pueden vender/entregar a un trabajador (Adelantos y Víveres).
// Cada compra de estas categorías puede tener su propio "precio de venta al trabajador" (por lote),
// y el consumo se cobra siguiendo FIFO (primero en entrar, primero en salir).
const ALMACEN_CATEGORIAS_VENTA_PERSONAL = ["Víveres", "Accesorios", "Herramientas"];

function renderAlmacen(root) {
  const pendientesCount = STATE.diario.filter(r => DIARIO_CATEGORIA_A_ALMACEN[r.categoria] && r.tipo === "EGRESO" && !(Number(r.cantidad) > 0)).length;
  root.innerHTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="productos">Productos</button>
      <button class="tab-btn" data-tab="pendientes">Completar cantidades${pendientesCount ? ` (${pendientesCount})` : ""}</button>
      <button class="tab-btn" data-tab="compras">Compras (ingreso a stock)</button>
      <button class="tab-btn" data-tab="salidas">🩺 Trabajos Sanitarios</button>
      <button class="tab-btn" data-tab="conteo">Control de Inventario</button>
      <button class="tab-btn" data-tab="kardex">Kardex por producto</button>
    </div>
    <div id="almacenContent"></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => {
    if (b.dataset.tab === uiState.almacenTab) b.classList.add("active");
    b.addEventListener("click", () => { uiState.almacenTab = b.dataset.tab; renderAlmacen(root); });
  });
  const content = root.querySelector("#almacenContent");

  if (uiState.almacenTab === "pendientes") { renderAlmacenPendientes(content, root); return; }
  if (uiState.almacenTab === "compras") { renderAlmacenCompras(content, root); return; }
  if (uiState.almacenTab === "salidas") { renderAlmacenSalidas(content, root); return; }
  if (uiState.almacenTab === "conteo") { renderAlmacenConteo(content, root); return; }
  if (uiState.almacenTab === "kardex") { renderAlmacenKardex(content, root); return; }
  renderAlmacenProductos(content, root);
}

/**
 * Busca una cantidad + unidad escrita como texto libre (ej. "Arroz 50kg", "Diesel 100 litros",
 * "Vacuna aftosa 30 dosis"). Devuelve null si no encuentra ningún número con unidad reconocible
 * — a propósito NO inventa una cantidad si no hay ninguna escrita en ningún lado.
 */
function detectarCantidadUnidad(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(\d+(?:[.,]\d+)?)\s*(kilogramos?|kilos?|kgs?|litros?|lts?\.?|bolsas?|dosis|unidades?|unid\.?)\b/i);
  if (!m) return null;
  const cantidad = Number(m[1].replace(",", "."));
  if (!cantidad) return null;
  const u = m[2].toLowerCase();
  let unidad = "Unidad";
  if (/^kil|^kg/.test(u)) unidad = "Kilos";
  else if (/^lit|^lt/.test(u)) unidad = "Litros";
  else if (/^dosis/.test(u)) unidad = "Dosis";
  else if (/^bolsa/.test(u)) unidad = "Bolsa";
  else if (/^unid/.test(u)) unidad = "Unidad";
  return { cantidad, unidad };
}

/**
 * Lista todas las compras que ya están cargadas en el Diario bajo una categoría de
 * almacén (Víveres/Accesorios/Sanidad/Nutrición/Combustible) pero que todavía NO tienen
 * cantidad cargada (compras hechas antes de que existiera este control, o cargadas sin
 * completar el dato). Desde acá se completa Cantidad/Unidad/Precio unitario de cada una
 * y el stock de Almacén se actualiza al instante — así el almacén queda "como tiene que
 * ser": reflejando de verdad lo que ya se compró, no solo lo que se compre de ahora en más.
 */
function renderAlmacenPendientes(host, root) {
  const pendientes = STATE.diario
    .filter(r => DIARIO_CATEGORIA_A_ALMACEN[r.categoria] && r.tipo === "EGRESO" && !(Number(r.cantidad) > 0))
    .sort((a,b) => (a.fecha||"").localeCompare(b.fecha||""));

  if (!pendientes.length) {
    host.innerHTML = `<div class="empty-state">🎉 No hay compras pendientes de completar — todas las compras de Víveres, Accesorios, Sanidad, Nutrición y Combustible que cargaste en el Diario ya tienen su cantidad y están reflejadas en el stock de Almacén.</div>`;
    return;
  }

  host.innerHTML = `
    <div class="note">Estas son compras que ya cargaste en el <b>Diario</b> (categorías de almacén) pero todavía no tienen <b>Cantidad</b> cargada, así que no suman stock. Completá Cantidad, Unidad y Precio unitario de cada una (el precio se calcula solo si dejás uno vacío) y tocá "Guardar" — el stock de Almacén se actualiza al toque, y la fila desaparece de esta lista.</div>
    <div class="form-actions" style="margin-bottom:14px"><button class="btn secondary" id="btnAutoDetectar">🔍 Detectar cantidades automáticamente (desde lo que ya escribiste)</button></div>
    <div id="pendientesList"></div>
  `;

  host.querySelector("#btnAutoDetectar").addEventListener("click", () => {
    let resueltas = 0;
    pendientes.forEach(row => {
      const det = detectarCantidadUnidad(`${row.subcategoria || ""} ${row.descripcion || ""}`);
      if (det) {
        crudUpdate("diario", row.id, { cantidad: det.cantidad, unidad: det.unidad, precioUnitario: (Number(row.monto) || 0) / det.cantidad });
        resueltas++;
      }
    });
    alert(resueltas > 0
      ? `Se completaron ${resueltas} compra(s) automáticamente a partir de una cantidad que ya estaba escrita en el texto (ej. "50kg", "20 litros"). Las que no tenían ninguna cantidad mencionada en ningún lado quedan para completar a mano abajo — esas no se pueden adivinar.`
      : `No encontré ninguna cantidad escrita en el texto de las compras pendientes (ej. "50kg", "20 litros"). Hay que completarlas a mano abajo — no puedo inventar una cantidad que nunca se escribió en ningún lado.`);
    renderAlmacen(root);
  });

  function pintarFila(row) {
    return `
      <div class="card tight" data-row-id="${row.id}" style="margin-bottom:10px">
        <div class="form-grid">
          <div class="field"><label>Fecha</label><input type="text" value="${fmtDate(row.fecha)}" disabled></div>
          <div class="field"><label>Nº comprobante</label><input type="text" value="${escapeHtml(row.numeroComprobante||"—")}" disabled></div>
          <div class="field"><label>Categoría</label><input type="text" value="${escapeHtml(row.categoria)}" disabled></div>
          <div class="field"><label>Producto</label><input type="text" value="${escapeHtml(row.subcategoria||"(sin nombre)")}" disabled></div>
          <div class="field"><label>Monto cargado (Bs)</label><input type="text" value="${fmtMoney2(row.monto)}" disabled></div>
          <div class="field"><label>Cantidad *</label><input type="number" step="0.01" class="pCantidad"></div>
          <div class="field"><label>Unidad</label>
            <input type="text" class="pUnidad" list="pUnidadList_${row.id}" placeholder="Kilos, Litros…">
            <datalist id="pUnidadList_${row.id}"><option value="Kilos"><option value="Litros"><option value="Unidad"><option value="Dosis"><option value="Bolsa"></datalist>
          </div>
          <div class="field"><label>Precio unitario (Bs)</label><input type="number" step="0.01" class="pPrecio"></div>
          ${ALMACEN_CATEGORIAS_VENTA_PERSONAL.includes(DIARIO_CATEGORIA_A_ALMACEN[row.categoria]) ? `
          <div class="field"><label>Precio venta trabajador (este lote)</label><input type="number" step="0.01" class="pPrecioVenta" placeholder="Opcional"></div>` : ""}
        </div>
        <div class="form-actions"><button type="button" class="btn pGuardar">💾 Guardar y sumar a stock</button></div>
      </div>`;
  }

  const listHost = host.querySelector("#pendientesList");
  listHost.innerHTML = pendientes.map(pintarFila).join("");

  listHost.querySelectorAll("[data-row-id]").forEach(card => {
    const rowId = card.dataset.rowId;
    const cantidadEl = card.querySelector(".pCantidad");
    const precioEl = card.querySelector(".pPrecio");
    card.querySelector(".pGuardar").addEventListener("click", () => {
      const row = STATE.diario.find(r => r.id === rowId);
      const cantidad = Number(cantidadEl.value) || 0;
      const unidad = card.querySelector(".pUnidad").value.trim();
      const precioUnitario = Number(precioEl.value) || 0;
      const precioVentaEl = card.querySelector(".pPrecioVenta");
      const precioVentaLote = (precioVentaEl && precioVentaEl.value !== "") ? Number(precioVentaEl.value) : undefined;
      if (!cantidad) { alert("Cargá una cantidad mayor a cero."); return; }
      crudUpdate("diario", rowId, { cantidad, unidad, precioUnitario: precioUnitario || (Number(row.monto)||0) / cantidad, precioVentaLote });
      renderAlmacen(root);
    });
  });
}

function renderAlmacenProductos(host, root) {
  // Ojo: NO se suma el stock de todos los productos de una categoría en un solo número —
  // cada producto tiene su propia unidad (kilos, litros, unidades, dosis…) y sumarlos todos
  // juntos mezclaría cosas que no se pueden sumar (ej. kg de arroz + litros de aceite).
  // Por eso acá solo se cuenta cuántos productos distintos hay por categoría; la cantidad
  // real de cada uno (por nombre) está en la tabla de abajo.
  const resumenPorCategoria = ALMACEN_CATEGORIAS_UI.map(cat => ({
    cat,
    cantidadProductos: STATE.almacenProductos.filter(p => p.categoria === cat).length
  }));
  host.innerHTML = `
    <div class="note">Catálogo de productos del almacén: víveres, accesorios, herramientas, sanidad, nutrición y combustible. El <b>stock actual</b> se calcula solo a partir de las compras y salidas que cargues en las otras pestañas — no lo edites acá directamente, se recalcula solo. La cantidad de cada producto (por nombre, con su propia unidad) está en la columna "Stock actual" de la tabla de abajo. Los productos que ya escribiste en el Diario (Producto/Detalle) se agregan solos acá cada vez que abrís la app; si cargaste algo nuevo hace un rato y todavía no aparece, usá el botón de abajo para forzar la actualización ahora mismo.
    <br><br>Para <b>Víveres, Accesorios y Herramientas</b> (lo que se le vende/entrega al personal): el <b>"Precio venta por defecto"</b> de acá abajo solo se usa cuando una compra puntual no tiene su propio precio cargado. Lo normal es cargar el precio de venta <b>en cada compra</b> (Diario → Gastos e Ingresos o Compra con varios productos, campo "Precio de venta al trabajador — este lote"), así cada lote puede venderse a un precio distinto y el consumo se cobra siempre <b>primero el lote más viejo</b> (FIFO).</div>
    <div class="grid cols-4" style="margin-bottom:16px">
      ${resumenPorCategoria.map(s => `<div class="card kpi"><span class="kpi-label">${s.cat}</span><span class="kpi-value">${s.cantidadProductos} producto${s.cantidadProductos===1?"":"s"}</span></div>`).join("")}
    </div>
    <div class="form-actions" style="margin-bottom:16px"><button class="btn secondary" id="btnBackfillAlmacen">🔄 Actualizar productos desde Diario</button></div>
    <div id="productosTableHost"></div>
  `;
  host.querySelector("#btnBackfillAlmacen").addEventListener("click", () => {
    const creados = backfillAlmacenProductosDesdeDiario();
    alert(creados > 0 ? `Se agregaron ${creados} producto(s) nuevo(s) al catálogo, tomados de lo ya cargado en el Diario.` : "No se encontraron productos nuevos — el catálogo ya está al día con el Diario.");
    renderAlmacen(root);
  });
  mountCrudTable(host.querySelector("#productosTableHost"), {
    collection: "almacenProductos",
    emptyText: "Todavía no cargaste productos de almacén. Agregá acá cada producto (ej: Arroz, Botas, Vacuna Aftosa, Sal mineral…) y después registrá sus compras en la otra pestaña.",
    sortFn: (a,b) => (a.nombre||"").localeCompare(b.nombre||""),
    columns: [
      { key: "nombre", label: "Producto", type: "text", required: true },
      { key: "categoria", label: "Categoría", type: "select", options: ALMACEN_CATEGORIAS_UI, required: true },
      { key: "unidad", label: "Unidad", type: "text" },
      { key: "precioVentaTrabajador", label: "Precio venta por defecto (Bs)", type: "number", step: "0.01", numeric: true }
    ],
    extraColumns: [
      { label: "Stock actual", numeric: true, render: row => `${fmtNum(row.stock||0)} ${escapeHtml(row.unidad||"")}` }
    ],
    onAfterChange: () => renderAlmacen(root)
  });
}

function renderAlmacenCompras(host, root) {
  host.innerHTML = `
    <div class="note">Esta pestaña es solo el <b>historial</b> de compras — se llena sola cada vez que cargás un gasto de Víveres, Accesorios, Sanidad o Nutrición en <b>Diario → Gastos e Ingresos</b> con Cantidad y Precio unitario. No hace falta cargar nada acá directamente; si necesitás corregir una compra, editala o borrala en el Diario (o acá abajo, aunque para categoría/monto es mejor hacerlo desde el Diario para que quede igual en los dos lados).</div>
    <div id="comprasTableHost"></div>
  `;
  mountCrudTable(host.querySelector("#comprasTableHost"), {
    collection: "almacenMovimientos",
    noAddForm: true,
    data: () => STATE.almacenMovimientos.filter(m => m.tipo === "compra"),
    emptyText: "Todavía no cargaste compras de almacén.",
    sortFn: (a,b) => (b.fecha||"").localeCompare(a.fecha||""),
    columns: [
      { key: "fecha", label: "Fecha", type: "date", required: true },
      { key: "productoId", label: "Producto", type: "select", options: () => STATE.almacenProductos.map(p=>({value:p.id,label:p.nombre})), required: true },
      { key: "cantidad", label: "Cantidad", type: "number", step: "0.01", numeric: true },
      { key: "precioUnitario", label: "Precio unit. (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "total", label: "Total (Bs)", type: "number", step: "0.01", numeric: true },
      { key: "observacion", label: "Observación", type: "text" },
      { key: "numeroComprobante", label: "Nº comprobante", type: "text" },
      { key: "beneficiario", label: "Beneficiario", type: "text" },
      { key: "comprobante", label: "Comprobante de pago", type: "image" },
      { key: "facturaCompra", label: "Factura / Recibo de compra", type: "image" }
    ],
    formatCell: (row, col) => {
      if (col.key === "productoId") { const p = STATE.almacenProductos.find(x=>x.id===row.productoId); return escapeHtml(p ? p.nombre : "—"); }
      if (col.key === "precioUnitario" || col.key === "total") return fmtMoney2(row[col.key]);
      return escapeHtml(row[col.key]);
    },
    footer: rows => `<tr><td colspan="4">Total</td><td class="num">${fmtMoney2(sum(rows.map(r=>r.total)))}</td><td></td><td></td><td></td><td></td></tr>`,
    onAfterChange: () => renderAlmacen(root)
  });
}

/**
 * Trabajos Sanitarios: registrar acá vacunación, desparasitación, mineralización,
 * areteado (o cualquier otro tipo que agregues) aplicado a una categoría/tropa de
 * ganado, con el/los producto(s) de Sanidad o Nutrición realmente usados — el stock
 * se descuenta solo, sin generar un gasto nuevo (el gasto ya se cargó al comprar el
 * producto).
 */
function renderAlmacenSalidas(host, root) {
  const hoy = new Date().toISOString().slice(0, 10);
  const productosSN = STATE.almacenProductos.filter(p => p.categoria === "Sanidad" || p.categoria === "Nutrición");
  if (!STATE.categoriasGanado.length) {
    host.innerHTML = `<div class="empty-state">Primero agregá alguna categoría de ganado (tropa) en <b>Configuración</b>.</div>`;
    return;
  }
  if (!productosSN.length) {
    host.innerHTML = `<div class="empty-state">Primero agregá algún producto de categoría <b>Sanidad</b> o <b>Nutrición</b> en la pestaña <b>Productos</b>.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="note">Registrá acá un trabajo sanitario (vacunación, desparasitación, mineralización, areteado, u otro que definas) aplicado a una <b>categoría/tropa</b> de ganado, con el o los productos de <b>Sanidad</b> o <b>Nutrición</b> realmente usados — el stock de cada producto se descuenta solo, sin generar un gasto nuevo (el gasto ya se cargó cuando compraste el producto).</div>
    <div class="card form-card">
      <div class="form-grid">
        <div class="field"><label>Fecha *</label><input type="date" id="tsFecha" value="${hoy}"></div>
        <div class="field"><label>Categoría / Tropa *</label>
          <select id="tsCategoria">
            <option value=""></option>
            ${STATE.categoriasGanado.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Cabezas tratadas</label><input type="number" step="1" id="tsCabezas" placeholder="Opcional"></div>
        <div class="field"><label>Tipo de trabajo *</label>
          <select id="tsTipo">
            <option value=""></option>
            ${STATE.tiposTrabajoSanitario.map(t => `<option value="${t.id}">${escapeHtml(t.nombre)}</option>`).join("")}
            <option value="__nuevo__">➕ Crear nuevo tipo…</option>
          </select>
          <input type="text" id="tsTipoNuevo" placeholder="Nombre del nuevo tipo" style="display:none;margin-top:6px">
        </div>
        <div class="field"><label>Observaciones</label><input type="text" id="tsObs" placeholder="Ej: Potrero 3, refuerzo, campaña invierno…"></div>
      </div>
    </div>

    <div class="section-title" style="margin-top:18px">Producto(s) de Sanidad / Nutrición usados</div>
    <div id="tsLineasHost"></div>
    <div class="form-actions" style="margin-top:10px">
      <button type="button" class="btn secondary" id="tsAgregarLinea">➕ Agregar producto</button>
    </div>
    <div class="form-actions" style="margin-top:14px">
      <button type="button" class="btn" id="tsGuardar">💾 Registrar trabajo sanitario</button>
    </div>

    <div id="trabajosSanitariosHistorial" style="margin-top:26px"></div>
  `;

  const tipoSelect = host.querySelector("#tsTipo");
  const tipoNuevoInput = host.querySelector("#tsTipoNuevo");
  tipoSelect.addEventListener("change", () => {
    tipoNuevoInput.style.display = tipoSelect.value === "__nuevo__" ? "" : "none";
  });

  const lineasHost = host.querySelector("#tsLineasHost");
  let lineaSeq = 0;

  function pintarLineaHtml(id) {
    return `
      <div class="card tight linea-row" data-linea-id="${id}" style="margin-bottom:10px">
        <div class="form-grid">
          <div class="field"><label>Producto *</label>
            <select class="tsLnProducto">
              <option value=""></option>
              ${productosSN.map(p => `<option value="${p.id}">${escapeHtml(p.nombre)} (stock: ${fmtNum(p.stock||0)} ${escapeHtml(p.unidad||"")})</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Cantidad usada *</label><input type="number" step="0.01" class="tsLnCantidad"></div>
        </div>
        <div class="form-actions"><button type="button" class="btn secondary small tsLnQuitar">🗑️ Quitar</button></div>
      </div>`;
  }
  function agregarLinea() {
    lineaSeq++;
    lineasHost.insertAdjacentHTML("beforeend", pintarLineaHtml(lineaSeq));
    lineasHost.querySelector(`[data-linea-id="${lineaSeq}"] .tsLnQuitar`).addEventListener("click", e => {
      e.target.closest(".linea-row").remove();
    });
  }
  host.querySelector("#tsAgregarLinea").addEventListener("click", agregarLinea);
  agregarLinea();

  host.querySelector("#tsGuardar").addEventListener("click", () => {
    const fecha = host.querySelector("#tsFecha").value || hoy;
    const categoriaGanadoId = host.querySelector("#tsCategoria").value;
    const cabezas = Number(host.querySelector("#tsCabezas").value) || 0;
    const observaciones = host.querySelector("#tsObs").value.trim();
    let tipoTrabajoId = tipoSelect.value;

    if (!categoriaGanadoId) { alert("Elegí la categoría / tropa tratada."); return; }
    if (!tipoTrabajoId) { alert("Elegí (o creá) el tipo de trabajo sanitario."); return; }

    if (tipoTrabajoId === "__nuevo__") {
      const nombreNuevo = tipoNuevoInput.value.trim();
      if (!nombreNuevo) { alert("Escribí el nombre del nuevo tipo de trabajo."); return; }
      const tipo = findOrCreateTipoTrabajoSanitario(nombreNuevo);
      tipoTrabajoId = tipo.id;
    }

    const productos = Array.from(lineasHost.querySelectorAll(".linea-row")).map(card => ({
      productoId: card.querySelector(".tsLnProducto").value,
      cantidad: Number(card.querySelector(".tsLnCantidad").value) || 0
    })).filter(p => p.productoId && p.cantidad > 0);

    if (!productos.length) { alert("Agregá al menos un producto con cantidad mayor a cero."); return; }

    for (const p of productos) {
      const producto = STATE.almacenProductos.find(x => x.id === p.productoId);
      if (producto && p.cantidad > (producto.stock || 0)) {
        if (!confirm(`Stock de "${producto.nombre}" es ${fmtNum(producto.stock||0)} ${producto.unidad||""} y estás por descontar ${fmtNum(p.cantidad)}. ¿Continuar igual?`)) return;
      }
    }

    registrarTrabajoSanitario({ fecha, categoriaGanadoId, cabezas, tipoTrabajoId, observaciones, productos });
    renderAlmacen(root);
  });

  const historialHost = host.querySelector("#trabajosSanitariosHistorial");
  const historial = STATE.trabajosSanitarios.slice().sort((a,b) => (b.fecha||"").localeCompare(a.fecha||""));
  if (!historial.length) {
    historialHost.innerHTML = `<div class="section-title">Trabajos sanitarios ya registrados</div><div class="empty-state">Todavía no registraste ningún trabajo sanitario.</div>`;
  } else {
    historialHost.innerHTML = `
      <div class="section-title">Trabajos sanitarios ya registrados (${historial.length})</div>
      ${historial.map(t => {
        const categoria = STATE.categoriasGanado.find(c => c.id === t.categoriaGanadoId);
        const tipo = STATE.tiposTrabajoSanitario.find(x => x.id === t.tipoTrabajoId);
        const movs = productosDeTrabajoSanitario(t.id);
        return `
        <div class="card tight" data-trabajo-id="${t.id}" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
            <div>
              <b>${fmtDate(t.fecha)} · ${escapeHtml(tipo ? tipo.nombre : "—")}</b> — ${escapeHtml(categoria ? categoria.nombre : "—")}${t.cabezas ? ` (${t.cabezas} cabeza${t.cabezas===1?"":"s"})` : ""}
              ${t.observaciones ? `<div style="color:var(--text-muted,#666);font-size:12.5px">${escapeHtml(t.observaciones)}</div>` : ""}
              ${movs.length ? `<ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px">
                ${movs.map(m => {
                  const p = STATE.almacenProductos.find(x => x.id === m.productoId);
                  return `<li>${escapeHtml(p ? p.nombre : "—")}: ${fmtNum(m.cantidad)} ${escapeHtml(p ? p.unidad || "" : "")}</li>`;
                }).join("")}
              </ul>` : ""}
            </div>
            <button type="button" class="btn secondary small tsBorrar">🗑️ Borrar</button>
          </div>
        </div>`;
      }).join("")}
    `;
    historialHost.querySelectorAll("[data-trabajo-id]").forEach(card => {
      card.querySelector(".tsBorrar").addEventListener("click", () => {
        if (!confirm("¿Borrar este trabajo sanitario? Esto también revierte el stock descontado de los productos usados.")) return;
        eliminarTrabajoSanitario(card.dataset.trabajoId);
        renderAlmacen(root);
      });
    });
  }
}

/**
 * Control de inventario físico: el usuario cuenta lo que tiene realmente en el almacén y
 * lo compara contra el stock que calcula el sistema. Por cada producto contado que difiera,
 * se genera un ajuste (sobrante o faltante) que corrige el stock al instante, y el conteo
 * completo queda guardado en el historial de abajo para poder consultarlo después.
 */
function renderAlmacenConteo(host, root) {
  if (!STATE.almacenProductos.length) {
    host.innerHTML = `<div class="empty-state">Todavía no hay productos cargados en el almacén — agregá alguno en la pestaña <b>Productos</b> primero.</div>`;
    return;
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const categoriaFiltro = uiState.almacenConteoCategoria || "";
  const productos = STATE.almacenProductos
    .filter(p => !categoriaFiltro || p.categoria === categoriaFiltro)
    .slice()
    .sort((a,b) => (a.nombre||"").localeCompare(b.nombre||""));

  host.innerHTML = `
    <div class="note">Contá lo que tenés físicamente en el almacén y cargalo acá — no hace falta completar todos los productos, solo los que cuentes en este momento. Al guardar, si un producto contado difiere del stock del sistema, se genera un <b>ajuste</b> (sobrante o faltante) y el stock queda corregido al instante.</div>
    <div class="card tight" style="margin-bottom:16px">
      <div class="form-grid">
        <div class="field"><label>Fecha del conteo</label><input type="date" id="ctFecha" value="${hoy}"></div>
        <div class="field"><label>Filtrar por categoría</label>
          <select id="ctCategoria">
            <option value="">Todas</option>
            ${ALMACEN_CATEGORIAS_UI.map(c => `<option value="${c}" ${c===categoriaFiltro?"selected":""}>${c}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Producto</th><th>Categoría</th><th>Stock según sistema</th><th>Cantidad física contada</th><th>Diferencia</th></tr></thead>
        <tbody>
          ${productos.map(p => `
            <tr data-producto-id="${p.id}">
              <td>${escapeHtml(p.nombre)}</td>
              <td>${escapeHtml(p.categoria)}</td>
              <td class="num">${fmtNum(p.stock||0)} ${escapeHtml(p.unidad||"")}</td>
              <td><input type="number" step="0.01" class="ctContado" style="width:110px"></td>
              <td class="num ctDiferencia">—</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="form-actions" style="margin-top:14px"><button class="btn" id="btnGuardarConteo">💾 Guardar conteo y ajustar stock</button></div>
    <div id="conteoHistorialHost" style="margin-top:26px"></div>
  `;

  host.querySelector("#ctCategoria").addEventListener("change", e => {
    uiState.almacenConteoCategoria = e.target.value;
    renderAlmacen(root);
  });

  host.querySelectorAll("tr[data-producto-id]").forEach(tr => {
    const productoId = tr.dataset.productoId;
    const producto = STATE.almacenProductos.find(p => p.id === productoId);
    const inputContado = tr.querySelector(".ctContado");
    const celdaDif = tr.querySelector(".ctDiferencia");
    inputContado.addEventListener("input", () => {
      if (inputContado.value === "") { celdaDif.textContent = "—"; return; }
      const dif = Math.round((Number(inputContado.value) - (Number(producto.stock)||0)) * 100) / 100;
      celdaDif.textContent = (dif > 0 ? "+" : "") + fmtNum(dif);
      celdaDif.style.color = dif > 0 ? "var(--green-700, green)" : (dif < 0 ? "#b5332a" : "");
    });
  });

  host.querySelector("#btnGuardarConteo").addEventListener("click", () => {
    const fecha = host.querySelector("#ctFecha").value || hoy;
    const conteos = [];
    host.querySelectorAll("tr[data-producto-id]").forEach(tr => {
      const input = tr.querySelector(".ctContado");
      if (input.value === "") return;
      conteos.push({ productoId: tr.dataset.productoId, stockContado: Number(input.value) || 0 });
    });
    if (!conteos.length) { alert("Cargá al menos una cantidad contada."); return; }
    const detalle = registrarConteoInventario(fecha, conteos);
    const conDiferencia = detalle.filter(d => d.diferencia !== 0);
    const sobrantes = conDiferencia.filter(d => d.diferencia > 0).length;
    const faltantes = conDiferencia.filter(d => d.diferencia < 0).length;
    alert(conDiferencia.length
      ? `Conteo guardado: ${detalle.length} producto(s) contados, ${conDiferencia.length} con diferencia (${sobrantes} sobrante(s), ${faltantes} faltante(s)). El stock ya quedó ajustado.`
      : `Conteo guardado: ${detalle.length} producto(s) contados, todos coincidieron con el stock del sistema — sin ajustes.`);
    renderAlmacen(root);
  });

  const historial = STATE.almacenConteos.slice().sort((a,b) => (b.fecha||"").localeCompare(a.fecha||""));
  const histHost = host.querySelector("#conteoHistorialHost");
  if (!historial.length) {
    histHost.innerHTML = `<div class="section-title">Historial de conteos</div><div class="empty-state">Todavía no registraste ningún control de inventario.</div>`;
  } else {
    histHost.innerHTML = `
      <div class="section-title">Historial de conteos</div>
      ${historial.map(h => {
        const conDif = h.detalle.filter(d => d.diferencia !== 0);
        return `
        <div class="card tight" style="margin-bottom:10px">
          <b>${fmtDate(h.fecha)}</b> — ${h.detalle.length} producto(s) contados, ${conDif.length} con diferencia
          ${conDif.length ? `
            <table style="margin-top:8px;width:100%;font-size:12.5px">
              <thead><tr><th style="text-align:left">Producto</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead>
              <tbody>
                ${conDif.map(d => `<tr>
                  <td>${escapeHtml(d.nombre)}</td>
                  <td class="num">${fmtNum(d.stockSistema)}</td>
                  <td class="num">${fmtNum(d.stockContado)}</td>
                  <td class="num" style="color:${d.diferencia>0?'var(--green-700, green)':'#b5332a'}">${d.diferencia>0?"+":""}${fmtNum(d.diferencia)} ${escapeHtml(d.unidad||"")}</td>
                </tr>`).join("")}
              </tbody>
            </table>` : ""}
        </div>`;
      }).join("")}
    `;
  }
}

/**
 * Kardex por producto: ficha de un solo producto de Almacén con todo su historial de
 * movimientos (compras, consumos, ajustes) con saldo corrido, más un resumen para poder
 * comparar precios de compra y ver cada cuánto y cuánto se compra de ese insumo.
 */
function renderAlmacenKardex(host, root) {
  if (!STATE.almacenProductos.length) {
    host.innerHTML = `<div class="empty-state">Todavía no hay productos cargados en el almacén — agregá alguno en la pestaña <b>Productos</b> primero.</div>`;
    return;
  }
  const productosOrdenados = STATE.almacenProductos.slice().sort((a,b) => (a.nombre||"").localeCompare(b.nombre||""));
  if (!uiState.almacenKardexProductoId || !productosOrdenados.some(p => p.id === uiState.almacenKardexProductoId)) {
    uiState.almacenKardexProductoId = productosOrdenados[0].id;
  }
  const producto = productosOrdenados.find(p => p.id === uiState.almacenKardexProductoId);

  const movs = STATE.almacenMovimientos
    .filter(m => m.productoId === producto.id)
    .slice()
    .sort((a,b) => (a.fecha||"").localeCompare(b.fecha||"") || 0);

  let saldo = 0;
  const movsConSaldo = movs.map(m => {
    const cant = Number(m.cantidad) || 0;
    saldo += (m.tipo === "compra" || m.tipo === "ajuste") ? cant : -cant;
    return { ...m, saldo: Math.round(saldo * 100) / 100 };
  });

  const compras = movs.filter(m => m.tipo === "compra").sort((a,b) => (a.fecha||"").localeCompare(b.fecha||""));
  const cantidadComprada = sum(compras.map(c => c.cantidad));
  const gastoTotal = sum(compras.map(c => c.total));
  const precioProm = cantidadComprada > 0 ? gastoTotal / cantidadComprada : 0;
  const precios = compras.map(c => Number(c.precioUnitario) || 0).filter(p => p > 0);
  const precioMin = precios.length ? Math.min(...precios) : 0;
  const precioMax = precios.length ? Math.max(...precios) : 0;
  let frecuenciaDias = null;
  if (compras.length > 1) {
    const primera = new Date(compras[0].fecha);
    const ultima = new Date(compras[compras.length - 1].fecha);
    const dias = (ultima - primera) / (1000 * 60 * 60 * 24);
    frecuenciaDias = Math.round(dias / (compras.length - 1));
  }

  host.innerHTML = `
    <div class="note">Elegí un producto para ver su <b>kardex</b>: todo el historial de compras, consumos y ajustes con saldo corrido, y un resumen para comparar precios de compra y la frecuencia con que se compra.</div>
    <div class="field" style="max-width:340px;margin-bottom:16px">
      <label>Producto</label>
      <select id="kxProducto">
        ${productosOrdenados.map(p => `<option value="${p.id}" ${p.id===producto.id?"selected":""}>${escapeHtml(p.nombre)} (${escapeHtml(p.categoria)})</option>`).join("")}
      </select>
    </div>
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="card kpi"><span class="kpi-label">Stock actual</span><span class="kpi-value">${fmtNum(producto.stock||0)} ${escapeHtml(producto.unidad||"")}</span></div>
      <div class="card kpi"><span class="kpi-label">Compras registradas</span><span class="kpi-value">${compras.length}</span></div>
      <div class="card kpi"><span class="kpi-label">Cantidad total comprada</span><span class="kpi-value">${fmtNum(cantidadComprada)}</span></div>
      <div class="card kpi"><span class="kpi-label">Gasto total en compras</span><span class="kpi-value">${fmtMoney2(gastoTotal)}</span></div>
      <div class="card kpi"><span class="kpi-label">Precio promedio (Bs)</span><span class="kpi-value">${fmtMoney2(precioProm)}</span></div>
      <div class="card kpi"><span class="kpi-label">Precio mínimo / máximo</span><span class="kpi-value">${fmtMoney2(precioMin)} / ${fmtMoney2(precioMax)}</span></div>
      <div class="card kpi"><span class="kpi-label">Frecuencia de compra</span><span class="kpi-value">${frecuenciaDias != null ? `cada ${frecuenciaDias} días` : "—"}</span></div>
    </div>
    ${compras.length > 1 ? `<div class="chart-card" style="margin-bottom:16px"><canvas id="kxChart" height="90"></canvas></div>` : ""}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Precio unit.</th><th>Total</th><th>Saldo</th><th>Observación</th></tr></thead>
        <tbody>
          ${movsConSaldo.length ? movsConSaldo.map(m => {
            const esEntrada = m.tipo === "compra" || (m.tipo === "ajuste" && m.cantidad > 0);
            const tipoLabel = { compra: "Compra", consumo_trabajador: "Venta a trabajador", consumo: "Consumo", ajuste: m.cantidad > 0 ? "Ajuste (sobrante)" : "Ajuste (faltante)" }[m.tipo] || m.tipo;
            return `<tr>
              <td>${fmtDate(m.fecha)}</td>
              <td>${tipoLabel}</td>
              <td class="num" style="color:${esEntrada?'var(--green-700, green)':'#b5332a'}">${esEntrada?"+":"-"}${fmtNum(Math.abs(m.cantidad))}</td>
              <td class="num">${m.precioUnitario ? fmtMoney2(m.precioUnitario) : "—"}</td>
              <td class="num">${m.total ? fmtMoney2(m.total) : "—"}</td>
              <td class="num"><b>${fmtNum(m.saldo)}</b></td>
              <td>${escapeHtml(m.observacion||"")}</td>
            </tr>`;
          }).join("") : `<tr><td colspan="7" style="text-align:center;color:#777">Este producto todavía no tiene movimientos registrados.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  host.querySelector("#kxProducto").addEventListener("change", e => {
    uiState.almacenKardexProductoId = e.target.value;
    renderAlmacen(root);
  });

  if (compras.length > 1) {
    chartKardexPrecio("kxChart", compras);
  }
}

/* ==========================================================================
   COMPROBANTES — galería rápida de todas las fotos de facturas/recibos
   cargadas en Diario, Personal (adelantos/víveres) y Ganado, en un solo lugar.
   ========================================================================== */
function recolectarComprobantes() {
  const out = [];
  STATE.diario.forEach(r => {
    if (r.comprobante) {
      out.push({
        origen: "Diario", fecha: r.fecha,
        categoria: r.categoria || "—",
        detalle: r.subcategoria || r.descripcion || "",
        monto: r.monto, tipo: r.tipo,
        numeroComprobante: r.numeroComprobante, beneficiario: r.beneficiario,
        comprobante: r.comprobante, esFactura: false
      });
    }
    if (r.facturaCompra) {
      out.push({
        origen: "Diario", fecha: r.fecha,
        categoria: r.categoria || "—",
        detalle: r.subcategoria || r.descripcion || "",
        monto: r.monto, tipo: r.tipo,
        numeroComprobante: r.numeroComprobante, beneficiario: r.beneficiario,
        comprobante: r.facturaCompra, esFactura: true
      });
    }
  });
  STATE.personalMovimientos.forEach(r => {
    const emp = STATE.empleados.find(e => e.id === r.empleadoId);
    const monto = (Number(r.adelanto) || 0) + (Number(r.utensilios) || 0) + (Number(r.consumo) || 0);
    if (r.comprobante) {
      out.push({
        origen: "Personal", fecha: r.fecha,
        categoria: emp ? emp.cargo : "Trabajador",
        detalle: r.concepto || "Adelanto / Víveres",
        monto, tipo: "EGRESO",
        numeroComprobante: r.numeroComprobante, beneficiario: r.beneficiario,
        comprobante: r.comprobante, esFactura: false
      });
    }
    if (r.facturaCompra) {
      out.push({
        origen: "Personal", fecha: r.fecha,
        categoria: emp ? emp.cargo : "Trabajador",
        detalle: r.concepto || "Adelanto / Víveres",
        monto, tipo: "EGRESO",
        numeroComprobante: r.numeroComprobante, beneficiario: r.beneficiario,
        comprobante: r.facturaCompra, esFactura: true
      });
    }
  });
  STATE.ganadoMovimiento.forEach(r => {
    if (!r.comprobante) return;
    out.push({
      origen: "Ganado", fecha: r.fecha,
      categoria: r.categoria || "—",
      detalle: `${r.tipo || ""}${r.cabezas ? " · " + r.cabezas + " cab." : ""}`.trim(),
      monto: montoTotalGanadoRow(r),
      tipo: r.tipo === "SALIDA" ? "INGRESO" : (r.tipo === "ENTRADA" ? "EGRESO" : ""),
      numeroComprobante: r.numeroComprobante, beneficiario: r.beneficiario || r.comprador,
      comprobante: r.comprobante, esFactura: false
    });
  });
  return out;
}

function comprobanteCaption(i) {
  const partes = [fmtDate(i.fecha), i.esFactura ? "Factura/Recibo" : "Comprobante de pago", i.origen, i.categoria, i.detalle, fmtMoney2(i.monto) + " Bs"];
  if (i.numeroComprobante) partes.push("Nº " + i.numeroComprobante);
  if (i.beneficiario) partes.push(i.beneficiario);
  return escapeHtml(partes.filter(Boolean).join(" · "));
}

function renderComprobantes(root, focus) {
  const f = uiState.comprobantesFiltro;
  const todos = recolectarComprobantes();
  let items = todos.slice();

  if (f.origen !== "todos") items = items.filter(i => i.origen === f.origen);
  if (f.desde) items = items.filter(i => (i.fecha || "") >= f.desde);
  if (f.hasta) items = items.filter(i => (i.fecha || "") <= f.hasta);
  if (f.texto) {
    const t = f.texto.toLowerCase();
    items = items.filter(i => [i.numeroComprobante, i.beneficiario, i.detalle, i.categoria]
      .some(v => (v || "").toLowerCase().includes(t)));
  }
  items.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const totalMonto = sum(items.map(i => Number(i.monto) || 0));

  root.innerHTML = `
    <div class="section">
      <div class="card tight" style="margin-bottom:16px">
        <div class="form-grid" style="align-items:end">
          <div class="field">
            <label>Buscar</label>
            <input id="cpTexto" type="text" placeholder="Nº comprobante, beneficiario, producto…" value="${escapeHtml(f.texto)}">
          </div>
          <div class="field">
            <label>Origen</label>
            <select id="cpOrigen">
              ${["todos", "Diario", "Personal", "Ganado"].map(o => `<option value="${o}" ${f.origen === o ? "selected" : ""}>${o === "todos" ? "Todos" : o}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Desde</label><input id="cpDesde" type="date" value="${f.desde}"></div>
          <div class="field"><label>Hasta</label><input id="cpHasta" type="date" value="${f.hasta}"></div>
          <div class="field"><button type="button" id="cpLimpiar" class="btn secondary">Limpiar filtros</button></div>
        </div>
      </div>

      <div class="grid cols-4" style="margin-bottom:18px">
        <div class="card kpi"><span class="kpi-label">Comprobantes encontrados</span><span class="kpi-value">${items.length}</span></div>
        <div class="card kpi"><span class="kpi-label">Monto total (Bs)</span><span class="kpi-value">${fmtMoney2(totalMonto)}</span></div>
      </div>

      ${items.length
        ? `<div class="comprobantes-grid">
            ${items.map(i => `
              <div class="comprobante-card">
                <img src="${i.comprobante}" class="comprobante-thumb lightbox-trigger" data-lightbox-caption="${comprobanteCaption(i)}" alt="Comprobante">
                <div class="comprobante-info">
                  <div class="comprobante-top">
                    <span class="tag ${i.tipo === "INGRESO" ? "ingreso" : "egreso"}">${i.origen}</span>
                    ${i.esFactura ? `<span class="tag">🧾 Factura</span>` : ""}
                    <span class="comprobante-fecha">${fmtDate(i.fecha)}</span>
                  </div>
                  <div class="comprobante-detalle">${escapeHtml(i.categoria)}${i.detalle ? " · " + escapeHtml(i.detalle) : ""}</div>
                  <div class="comprobante-monto">${fmtMoney2(i.monto)} Bs</div>
                  ${i.numeroComprobante ? `<div class="comprobante-meta">Nº ${escapeHtml(i.numeroComprobante)}</div>` : ""}
                  ${i.beneficiario ? `<div class="comprobante-meta">${escapeHtml(i.beneficiario)}</div>` : ""}
                </div>
              </div>`).join("")}
          </div>`
        : `<div class="empty-state">${todos.length ? "No hay comprobantes que coincidan con el filtro." : "Todavía no cargaste ningún comprobante (foto de factura/recibo) en el Diario, Personal o Ganado."}</div>`
      }
    </div>
  `;

  root.querySelector("#cpTexto").addEventListener("input", e => {
    f.texto = e.target.value;
    const cursor = e.target.selectionStart;
    renderComprobantes(root, { id: "cpTexto", cursor });
  });
  root.querySelector("#cpOrigen").addEventListener("change", e => { f.origen = e.target.value; renderComprobantes(root); });
  root.querySelector("#cpDesde").addEventListener("change", e => { f.desde = e.target.value; renderComprobantes(root); });
  root.querySelector("#cpHasta").addEventListener("change", e => { f.hasta = e.target.value; renderComprobantes(root); });
  root.querySelector("#cpLimpiar").addEventListener("click", () => {
    uiState.comprobantesFiltro = { texto: "", origen: "todos", desde: "", hasta: "" };
    renderComprobantes(root);
  });

  if (focus && focus.id) {
    const el = root.querySelector("#" + focus.id);
    if (el) {
      el.focus();
      if (focus.cursor != null && el.setSelectionRange) el.setSelectionRange(focus.cursor, focus.cursor);
    }
  }
}

/* ==========================================================================
   ROUTER DE VISTAS
   ========================================================================== */
const VIEW_RENDERERS = {
  inicio: renderInicio,
  diario: renderDiario,
  ganado: renderGanado,
  personal: renderPersonal,
  almacen: renderAlmacen,
  comprobantes: renderComprobantes,
  "gastos-fijos": renderGastosFijos,
  "gastos-variables": renderGastosVariables,
  financiero: renderFinanciero,
  analisis: renderAnalisis,
  configuracion: renderConfiguracion,
  datos: renderDatos
};

function renderView(name) {
  if (!VIEW_RENDERERS[name]) name = "inicio";
  uiState.currentView = name;
  document.getElementById("viewTitle").textContent = VIEW_TITLES[name] || name;
  document.querySelectorAll("#mainNav a").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  const root = document.getElementById("appContent");
  VIEW_RENDERERS[name](root);
}

function refreshCurrentView() { renderView(uiState.currentView); }
