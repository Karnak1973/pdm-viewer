import { describe, expect, it } from 'vitest';
import { buildTableText, createSchemaIndex, modelSignature } from './schemaIndex';
import { LexicalIndex } from './vectorizer';
import { splitIdentifier, singularize, termSet } from './text';
import { createDemoModel } from '../utils/sampleModel';

describe('utilidades de texto', () => {
  it('parte identificadores en palabras', () => {
    expect(splitIdentifier('OrderLineID')).toEqual(['Order', 'Line', 'ID']);
    expect(splitIdentifier('customer_id')).toEqual(['customer', 'id']);
    expect(splitIdentifier('FK_Order_Customer')).toEqual(['FK', 'Order', 'Customer']);
    expect(splitIdentifier('XMLParser')).toEqual(['XML', 'Parser']);
  });

  it('singulariza plurales sin destrozar palabras invariantes', () => {
    expect(singularize('pedidos')).toBe('pedido');
    expect(singularize('almacenes')).toBe('almacen');
    expect(singularize('categories')).toBe('category');
    expect(singularize('status')).toBe('status');
    expect(singularize('address')).toBe('address');
    expect(singularize('process')).toBe('process');
  });

  it('resuelve sinónimos entre español e inglés', () => {
    expect(termSet('clientes').has('cliente')).toBe(true);
    expect(termSet('Customer').has('cliente')).toBe(true);
    expect(termSet('facturas').has('factura')).toBe(true);
    expect(termSet('Invoice').has('factura')).toBe(true);
  });
});

describe('LexicalIndex', () => {
  const documents = [
    {
      id: 'customer',
      text: 'Customer Clientes del sistema CustomerID FirstName LastName Email',
      name: 'Customer Clientes',
    },
    { id: 'order', text: 'Order Pedidos OrderID CustomerID OrderDate Status', name: 'Order Pedidos' },
    { id: 'product', text: 'Product Productos articulo Price Stock', name: 'Product Productos' },
  ];

  it('encuentra por término exacto', () => {
    const index = new LexicalIndex(documents);
    expect(index.search('customer')[0]?.id).toBe('customer');
  });

  it('encuentra por sinónimo en español', () => {
    const index = new LexicalIndex(documents);
    expect(index.search('clientes')[0]?.id).toBe('customer');
  });

  it('encuentra por sinónimo en inglés desde una consulta en español', () => {
    const index = new LexicalIndex(documents);
    expect(index.search('factura')[0]?.id).not.toBe('order');
  });

  it('tolera erratas en el nombre de la tabla', () => {
    const index = new LexicalIndex(documents);
    expect(index.search('costumer')[0]?.id).toBe('customer');
    expect(index.search('orfer')[0]?.id).toBe('order');
  });

  it('devuelve una lista vacía con consultas sin contenido', () => {
    const index = new LexicalIndex(documents);
    expect(index.search('   ')).toEqual([]);
    expect(index.search('de la')).toEqual([]);
  });

  it('descarta documentos sin ninguna relación con la consulta', () => {
    const index = new LexicalIndex(documents);
    const hits = index.search('producto');
    expect(hits.map((hit) => hit.id)).toEqual(['product']);
  });

  it('ordena los resultados por afinidad descendente', () => {
    const index = new LexicalIndex(documents);
    const hits = index.search('customer');
    expect(hits.length).toBeGreaterThan(1);
    for (let position = 1; position < hits.length; position += 1) {
      expect(hits[position - 1].score).toBeGreaterThanOrEqual(hits[position].score);
    }
  });
});

describe('SchemaIndex', () => {
  const model = createDemoModel();

  it('arranca en modo léxico sin cargar el modelo neuronal', () => {
    const index = createSchemaIndex(model);
    expect(index.getMode()).toBe('lexical');
    expect(index.tableCount).toBe(model.tables.length);
  });

  it('indexa el rol estructural de las tablas', () => {
    const customer = model.tables[0];
    const text = buildTableText(customer, model);
    expect(text).toContain('Customer');
    expect(text).toContain('primary key');
  });

  it('incluye la tabla padre al describir una FK', () => {
    const order = model.tables.find((table) => table.code === 'Order');
    expect(order).toBeDefined();
    const text = buildTableText(order!, model);
    expect(text).toContain('Customer');
  });

  it('encuentra tablas con lenguaje natural en español', () => {
    const index = createSchemaIndex(model);
    expect(index.search('clientes')[0]?.id).toBe('table-1');
    expect(index.search('pedidos')[0]?.id).toBe('table-2');
  });

  it('genera una firma estable y sensible a cambios', () => {
    const signature = modelSignature(model);
    expect(modelSignature(model)).toBe(signature);

    const modified = createDemoModel();
    modified.tables[1].code = 'PurchaseOrder';
    expect(modelSignature(modified)).not.toBe(signature);
  });

  it('devuelve resultados vacíos con una consulta vacía', () => {
    const index = createSchemaIndex(model);
    expect(index.search('')).toEqual([]);
  });

  it('no calcula embeddings de consulta mientras el motor neuronal está apagado', async () => {
    // Garantía clave: sin motor neuronal activo, embedQuery NO debe llegar a
    // cargar el modelo, porque eso implicaría una descarga desde Internet.
    const index = createSchemaIndex(model);
    await expect(index.embedQuery('clientes')).resolves.toBeNull();

    // Se puede llamar repetidamente sin efecto: sigue sin descargar nada.
    await expect(index.embedQuery('pedidos')).resolves.toBeNull();
  });

  it('vuelve al motor local al desactivar el neuronal', async () => {
    const index = createSchemaIndex(model);
    index.disableNeural();

    expect(index.getMode()).toBe('lexical');
    await expect(index.embedQuery('clientes')).resolves.toBeNull();
    expect(index.search('clientes')[0]?.id).toBe('table-1');
  });
});
