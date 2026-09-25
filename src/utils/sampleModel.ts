import type { Model } from '../model/types';

export function createDemoModel(): Model {
  return {
    name: 'DemoModel',
    domains: [
      { id: 'domain-1', name: 'PK', dataType: 'INTEGER' },
      { id: 'domain-2', name: 'Text', dataType: 'VARCHAR(255)' },
    ],
    tables: [
      {
        id: 'table-1',
        code: 'Customer',
        name: 'Customer',
        comment: 'Clientes del sistema',
        position: { x: 60, y: 80, w: 260, h: 220 },
        columns: [
          { id: 'column-1', code: 'CustomerID', name: 'CustomerID', dataType: 'INTEGER', mandatory: true, identity: true, length: 10 },
          { id: 'column-2', code: 'FirstName', name: 'FirstName', dataType: 'VARCHAR', mandatory: false, identity: false, length: 100 },
          { id: 'column-3', code: 'LastName', name: 'LastName', dataType: 'VARCHAR', mandatory: true, identity: false, length: 100 },
          { id: 'column-4', code: 'Email', name: 'Email', dataType: 'VARCHAR', mandatory: false, identity: false, length: 200 },
        ],
        primaryKey: ['column-1'],
        keys: [{ id: 'key-1', name: 'PK_Customer', columns: ['column-1'], isPrimary: true }],
        indexes: [{ id: 'index-1', name: 'IX_Customer_Email', columns: ['column-4'], unique: false }],
      },
      {
        id: 'table-2',
        code: 'Order',
        name: 'Order',
        comment: 'Pedidos',
        position: { x: 420, y: 140, w: 260, h: 240 },
        columns: [
          { id: 'column-5', code: 'OrderID', name: 'OrderID', dataType: 'INTEGER', mandatory: true, identity: true, length: 10 },
          { id: 'column-6', code: 'CustomerID', name: 'CustomerID', dataType: 'INTEGER', mandatory: true, identity: false, length: 10 },
          { id: 'column-7', code: 'OrderDate', name: 'OrderDate', dataType: 'DATETIME', mandatory: true, identity: false },
          { id: 'column-8', code: 'Status', name: 'Status', dataType: 'VARCHAR', mandatory: false, identity: false, length: 50 },
        ],
        primaryKey: ['column-5'],
        keys: [{ id: 'key-2', name: 'PK_Order', columns: ['column-5'], isPrimary: true }],
        indexes: [{ id: 'index-2', name: 'IX_Order_CustomerID', columns: ['column-6'], unique: false }],
      },
      {
        id: 'table-3',
        code: 'OrderLine',
        name: 'OrderLine',
        comment: 'Líneas del pedido',
        position: { x: 790, y: 200, w: 260, h: 240 },
        columns: [
          { id: 'column-9', code: 'OrderLineID', name: 'OrderLineID', dataType: 'INTEGER', mandatory: true, identity: true, length: 10 },
          { id: 'column-10', code: 'OrderID', name: 'OrderID', dataType: 'INTEGER', mandatory: true, identity: false, length: 10 },
          { id: 'column-11', code: 'Product', name: 'Product', dataType: 'VARCHAR', mandatory: true, identity: false, length: 150 },
          { id: 'column-12', code: 'Quantity', name: 'Quantity', dataType: 'INTEGER', mandatory: true, identity: false, length: 10 },
        ],
        primaryKey: ['column-9'],
        keys: [{ id: 'key-3', name: 'PK_OrderLine', columns: ['column-9'], isPrimary: true }],
        indexes: [{ id: 'index-3', name: 'IX_OrderLine_OrderID', columns: ['column-10'], unique: false }],
      },
    ],
    references: [
      {
        id: 'reference-1',
        name: 'FK_Order_Customer',
        parentTable: 'table-1',
        childTable: 'table-2',
        joins: [{ parentColumn: 'column-1', childColumn: 'column-6' }],
        cardinality: '1:N',
        onDelete: 'No action',
        onUpdate: 'Cascade',
      },
      {
        id: 'reference-2',
        name: 'FK_OrderLine_Order',
        parentTable: 'table-2',
        childTable: 'table-3',
        joins: [{ parentColumn: 'column-5', childColumn: 'column-10' }],
        cardinality: '1:N',
        onDelete: 'Cascade',
        onUpdate: 'Cascade',
      },
    ],
  };
}
