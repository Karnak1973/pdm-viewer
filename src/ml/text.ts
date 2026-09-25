/**
 * Utilidades de texto para el motor semántico.
 *
 * El objetivo es convertir identificadores de esquema (CustomerID, customer_id,
 * FK_Order_Customer) y comentarios en lenguaje natural en conjuntos de términos
 * comparables, tolerando camelCase, snake_case, plurales y sinónimos ES/EN.
 */

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'con',
  'por',
  'para',
  'al',
  'en',
  'of',
  'the',
  'and',
  'for',
  'to',
  'from',
]);

/**
 * Grupos de sinónimos. El primer término del grupo es el representante canónico
 * y todos los demás se mapean a él, de forma que "cliente", "clientes" y
 * "customer" acaban compartiendo la misma característica.
 */
const SYNONYM_GROUPS: string[][] = [
  ['cliente', 'clientes', 'customer', 'customers', 'client', 'clients', 'comprador'],
  ['pedido', 'pedidos', 'order', 'orders', 'orden', 'ordenes'],
  ['factura', 'facturas', 'invoice', 'invoices', 'billing', 'facturacion'],
  ['linea', 'lineas', 'line', 'lines', 'detalle', 'detalles', 'detail', 'details'],
  ['producto', 'productos', 'product', 'products', 'articulo', 'articulos', 'item', 'items', 'sku'],
  ['empleado', 'empleados', 'employee', 'employees', 'trabajador', 'staff'],
  ['usuario', 'usuarios', 'user', 'users', 'cuenta', 'account', 'accounts'],
  ['proveedor', 'proveedores', 'supplier', 'suppliers', 'vendor', 'vendors'],
  ['pago', 'pagos', 'payment', 'payments', 'cobro', 'cobros'],
  ['direccion', 'direcciones', 'address', 'addresses'],
  ['importe', 'importes', 'total', 'totals', 'amount', 'amounts', 'monto', 'montos'],
  ['fecha', 'fechas', 'date', 'dates', 'day', 'dia'],
  ['precio', 'precios', 'price', 'prices', 'tarifa', 'tarifas', 'cost', 'coste', 'costo'],
  ['cantidad', 'cantidades', 'quantity', 'quantities', 'qty', 'number_of'],
  ['estado', 'estados', 'status', 'state', 'estatus'],
  ['categoria', 'categorias', 'category', 'categories'],
  ['nombre', 'nombres', 'name', 'names', 'denominacion'],
  ['apellido', 'apellidos', 'surname', 'lastname', 'last_name'],
  ['correo', 'email', 'emails', 'mail', 'e_mail'],
  ['telefono', 'telefonos', 'phone', 'phones', 'mobile', 'movil', 'celular'],
  ['stock', 'inventario', 'inventory', 'existencias'],
  ['almacen', 'almacenes', 'warehouse', 'warehouses', 'deposito'],
  ['envio', 'envios', 'shipment', 'shipments', 'shipping', 'expedicion'],
  ['impuesto', 'impuestos', 'tax', 'taxes', 'iva', 'vat'],
  ['moneda', 'monedas', 'currency', 'currencies', 'divisa'],
  ['documento', 'documentos', 'document', 'documents', 'doc', 'docs'],
  ['adjunto', 'adjuntos', 'attachment', 'attachments', 'file', 'fichero'],
  ['historial', 'history', 'audit', 'auditoria', 'log', 'logs', 'traza'],
  ['movimiento', 'movimientos', 'movement', 'transaction', 'transactions', 'transaccion'],
  ['saldo', 'saldos', 'balance', 'balances'],
  ['contrato', 'contratos', 'contract', 'contracts'],
  ['reserva', 'reservas', 'booking', 'bookings', 'reservation'],
  ['alumno', 'alumnos', 'student', 'students', 'estudiante', 'estudiantes'],
  ['profesor', 'profesores', 'teacher', 'teachers', 'docente', 'instructor'],
  ['curso', 'cursos', 'course', 'courses'],
  ['asignatura', 'asignaturas', 'subject', 'subjects', 'materia', 'materias'],
  ['matricula', 'matriculas', 'enrollment', 'enrollments', 'inscripcion'],
  ['nota', 'notas', 'grade', 'grades', 'calificacion'],
  ['proyecto', 'proyectos', 'project', 'projects'],
  ['tarea', 'tareas', 'task', 'tasks'],
  ['incidencia', 'incidencias', 'issue', 'issues', 'ticket', 'tickets'],
  ['sucursal', 'sucursales', 'branch', 'branches', 'oficina'],
  ['ciudad', 'ciudades', 'city', 'cities', 'localidad', 'municipio'],
  ['pais', 'paises', 'country', 'countries'],
  ['provincia', 'provincias', 'state_province', 'region', 'region'],
  ['codigo', 'codigos', 'code', 'codes', 'cod'],
  ['descripcion', 'description', 'descripcion_corta', 'detalle_texto'],
  ['activo', 'activa', 'active', 'enabled', 'habilitado', 'flag', 'is_active'],
  ['borrado', 'deleted', 'eliminado', 'is_deleted'],
  ['creado', 'created', 'creation', 'created_at', 'alta'],
  ['modificado', 'modified', 'updated', 'updated_at', 'modificacion'],
];

const SYNONYMS = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0];
  for (const term of group) {
    SYNONYMS.set(term, canonical);
  }
}

/** Devuelve el término canónico de un token, si pertenece a algún grupo. */
export function canonicalize(token: string): string | undefined {
  return SYNONYMS.get(token);
}

/**
 * Parte un identificador en sus palabras: `OrderLineID` -> [order, line, id],
 * `customer_id` -> [customer, id], `XMLParser` -> [xml, parser].
 */
export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Palabras que terminan en "s" sin ser plural, por lo que no deben recortarse.
 * `status`, `address` o `process` son nombres de columna muy habituales.
 */
const INVARIANT_WORDS = new Set([
  'status',
  'alias',
  'analysis',
  'address',
  'process',
  'access',
  'business',
  'class',
  'bus',
  'plus',
  'bonus',
  'campus',
  'virus',
  'series',
  'species',
  'atlas',
  'lens',
  'news',
  'gross',
  'pass',
  'mass',
  'cross',
  'case',
  'base',
  'release',
  'phase',
  'course',
  'purchase',
  'response',
  'expense',
  'license',
  'warehouse',
]);

/**
 * Singularización conservadora, pensada para que "pedidos" -> "pedido" y
 * "almacenes" -> "almacen" sin destrozar "status" o "address".
 */
export function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (INVARIANT_WORDS.has(token)) return token;

  // "ies" -> "y": categories -> category
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;

  // "es" tras consonante: almacenes -> almacen, ciudades -> ciudad.
  if (token.endsWith('es') && token.length > 4 && !/[aeiou]es$/.test(token)) {
    return token.slice(0, -2);
  }

  // "s" simple, evitando terminaciones que no son plural.
  if (token.endsWith('s') && token.length > 3 && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }

  return token;
}

/** Trigramas con padding, usados para tolerar erratas y variaciones ortográficas. */
export function trigrams(token: string): string[] {
  const padded = `#${token}#`;
  const result = new Set<string>();
  for (let index = 0; index < padded.length - 2; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return [...result];
}

export interface TokenizedText {
  /** Términos base encontrados en el texto. */
  tokens: string[];
  /** Términos canónicos añadidos por sinonimia. */
  expanded: string[];
}

/**
 * Convierte texto libre o identificadores en términos normalizados.
 *
 * Los plurales irregulares de la lista de sinónimos se resuelven por búsqueda
 * directa, que es más fiable que cualquier heurística de singularización.
 */
export function tokenize(value: string): TokenizedText {
  const tokens: string[] = [];
  const expanded: string[] = [];

  for (const raw of splitIdentifier(value)) {
    const lower = raw.toLowerCase();
    if (lower.length < 2 || STOPWORDS.has(lower)) continue;

    const directCanonical = SYNONYMS.get(lower);
    const token = directCanonical ? lower : singularize(lower);
    if (token.length < 2 || STOPWORDS.has(token)) continue;

    tokens.push(token);

    const canonical = directCanonical ?? SYNONYMS.get(token);
    if (canonical && canonical !== token) {
      expanded.push(canonical);
    }
  }

  return { tokens, expanded };
}

/** Conjunto de términos comparables de un texto (base + sinónimos). */
export function termSet(value: string): Set<string> {
  const { tokens, expanded } = tokenize(value);
  return new Set([...tokens, ...expanded]);
}

/**
 * Conjunto de términos normalizados a su forma canónica.
 *
 * Es la representación adecuada para comparar significado: "Customer" y
 * "Client" comparten el término canónico `cliente`, mientras que `termSet`
 * devolvería dos tokens distintos y penalizaría la similitud.
 */
export function canonicalTermSet(value: string): Set<string> {
  const { tokens } = tokenize(value);
  const result = new Set<string>();
  for (const token of tokens) {
    result.add(SYNONYMS.get(token) ?? token);
  }
  return result;
}

/**
 * Similitud de Levenshtein normalizada (1 = idénticos).
 *
 * Se usa para tolerar erratas que rompen los trigramas, como la transposición
 * de "costumer" frente a "customer".
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);

  for (let column = 0; column <= b.length; column += 1) previous[column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;

    for (let column = 1; column <= b.length; column += 1) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitution,
      );
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  const distance = previous[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/** Coeficiente de Dice sobre trigramas; útil para comparar nombres cortos. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  const setB = new Set(gramsB);

  let shared = 0;
  for (const gram of gramsA) {
    if (setB.has(gram)) shared += 1;
  }

  // Cada posición ausente cuenta como un trigrama que el otro lado no aporta.
  return (2 * shared) / (gramsA.length + gramsB.length);
}

/** Índice de Jaccard entre dos conjuntos. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
