# Mi Estancia — Gestión Ganadera (app web)

App de una sola página (HTML/CSS/JS, sin frameworks) para reemplazar el Excel:
Diario de gastos e ingresos, movimientos e inventario de ganado, sueldos y
planilla del personal, gastos fijos/variables, y los estados financieros
completos (Estado de Resultados, Flujo de Caja, Balance, Análisis).

Todo se calcula solo, como en el Excel. Los datos se guardan en el navegador
(localStorage) — no se necesita servidor ni base de datos.

## Cómo usarla ahora mismo (sin subir nada a internet)

Abrí `index.html` haciendo doble clic. Funciona offline en Chrome/Edge/Firefox
(las únicas conexiones externas son Chart.js y SheetJS, que se cargan desde un
CDN público la primera vez).

## Cómo publicarla en internet gratis (para entrar desde el celular)

**Opción A — Netlify (la más simple, 2 minutos, sin cuenta de GitHub):**
1. Entrá a https://app.netlify.com/drop
2. Arrastrá la carpeta `estancia-app` completa (la carpeta, no los archivos sueltos) a esa página.
3. Netlify te da una URL tipo `https://algo-random.netlify.app` — esa es tu app en internet.
4. Guardá esa URL en el celular (Agregar a pantalla de inicio) y listo.
5. Podés volver a arrastrar la carpeta cuando quieras "resubir" una versión nueva (no hace falta, los datos viven en el navegador de cada dispositivo, no en el hosting).

**Opción B — GitHub Pages (si ya usás GitHub):**
1. Creá un repositorio nuevo y subí el contenido de esta carpeta.
2. Settings → Pages → Source: rama `main`, carpeta `/root`.
3. En un minuto tenés la URL `https://tu-usuario.github.io/tu-repo/`.

## Importante sobre los datos

- Los datos que cargues quedan guardados en el navegador de cada dispositivo
  (localStorage). Si entrás desde el celular Y desde la computadora, son dos
  "libretas" separadas — no se sincronizan solas entre sí.
- Para pasar datos de un dispositivo a otro: andá a **Datos / Excel** →
  **Exportar copia de seguridad (.json)** en un dispositivo, y **Restaurar
  copia de seguridad (.json)** en el otro.
- También podés exportar todo a un **.xlsx** de respaldo (botón "Exportar a
  Excel") para mandarlo a tu contador o abrirlo en Excel/Google Sheets.
- Podés importar tu Excel actual (`Estancia_Ganadera_Costos.xlsx`) desde
  **Datos / Excel → Importar** para traer lo que ya tenías cargado (Diario,
  Ganado, Sueldos, Gastos Fijos).

## Estructura del proyecto

```
estancia-app/
├── index.html        (estructura de la página)
├── style.css          (todos los estilos)
├── js/
│   ├── db.js          (modelo de datos, guardado, import/export Excel)
│   ├── calc.js         (todas las fórmulas: sueldos, estado de resultados,
│   │                    flujo de caja, balance, análisis, inventario ganado)
│   ├── charts.js       (gráficos con Chart.js)
│   ├── render.js       (arma las pantallas y las tablas editables)
│   └── main.js         (arranque de la app y navegación)
└── README.md
```

No hay paso de "build" ni instalación de dependencias — son archivos estáticos
que cualquier hosting gratuito puede servir tal cual.

## Víveres y otros gastos: autocompletado que se auto-alimenta

En **Diario**, el campo "Producto / Detalle" recuerda lo que vas escribiendo
por categoría (por ejemplo, en Víveres / Alimentación: arroz, aceite, carne,
bidones de agua…). No hay que configurar nada: la primera vez escribís el
producto, y de ahí en más aparece como sugerencia — cada categoría arma su
propia lista sola a medida que cargás compras.

## Inventario individual de ganado (numeración / caravana)

En **Ganado → Inventario Individual** podés subir una planilla Excel propia
con las existencias y la numeración (caravana) de tus animales. La app
reconoce columnas como Número/Caravana, Categoría, Sexo, Peso, Fecha de
nacimiento, Potrero y Estado (en cualquier orden), y si aparece una categoría
que no existía se crea sola. Al importar, se actualiza automáticamente el
stock inicial en **Ganado → Levantamiento (CREA)**. También podés descargar
una planilla modelo desde esa misma pantalla como punto de partida.

## Alcance / próximos pasos posibles

- La app replica la lógica del Excel (categorías, cuentas, método CREA para
  el rodeo, depreciación, etc.), pero **no sincroniza automáticamente entre
  dispositivos** — es la limitación principal de no tener un servidor propio.
  Si más adelante querés que varios usuarios carguen datos desde distintos
  celulares y se vea todo junto en un solo lugar, el siguiente paso sería
  conectarla a una base de datos en la nube (por ejemplo Firebase o Supabase,
  ambos con planes gratuitos) — avisame si querés que lo arme.
