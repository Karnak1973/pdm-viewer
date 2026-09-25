import { describe, expect, it } from 'vitest';
import { parsePowerDesignerXml } from './xmlParser';
import { normalizeModel } from './normalizer';

describe('normalizeModel', () => {
  it('reads namespaced PowerDesigner XML and extracts tables, columns and references', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Model>
  <o:Tables>
    <o:Table>
      <o:Code>Customer</o:Code>
      <o:Name>Customer</o:Name>
      <c:Columns>
        <o:Column>
          <o:Code>CustomerID</o:Code>
          <o:Name>CustomerID</o:Name>
          <o:DataType>INTEGER</o:DataType>
          <o:Length>10</o:Length>
          <o:NotNull>1</o:NotNull>
        </o:Column>
        <o:Column>
          <o:Code>Email</o:Code>
          <o:Name>Email</o:Name>
          <o:DataType>VARCHAR</o:DataType>
          <o:Length>200</o:Length>
        </o:Column>
      </c:Columns>
      <o:PrimaryKey>
        <o:Key>
          <o:Column>CustomerID</o:Column>
        </o:Key>
      </o:PrimaryKey>
    </o:Table>
    <o:Table>
      <o:Code>Order</o:Code>
      <o:Name>Order</o:Name>
      <c:Columns>
        <o:Column>
          <o:Code>OrderID</o:Code>
          <o:Name>OrderID</o:Name>
          <o:DataType>INTEGER</o:DataType>
          <o:Length>10</o:Length>
          <o:NotNull>1</o:NotNull>
        </o:Column>
      </c:Columns>
    </o:Table>
  </o:Tables>
  <o:References>
    <o:Reference>
      <o:Name>FK_Order_Customer</o:Name>
      <o:ParentTable>Customer</o:ParentTable>
      <o:ChildTable>Order</o:ChildTable>
      <c:Joins>
        <o:Join>
          <o:ParentColumn>CustomerID</o:ParentColumn>
          <o:ChildColumn>OrderID</o:ChildColumn>
        </o:Join>
      </c:Joins>
    </o:Reference>
  </o:References>
  <o:TableSymbols>
    <o:TableSymbol>
      <o:Table>Customer</o:Table>
      <o:X>120</o:X>
      <o:Y>80</o:Y>
      <o:Width>220</o:Width>
      <o:Height>160</o:Height>
    </o:TableSymbol>
    <o:TableSymbol>
      <o:Table>Order</o:Table>
      <o:X>520</o:X>
      <o:Y>240</o:Y>
      <o:Width>220</o:Width>
      <o:Height>180</o:Height>
    </o:TableSymbol>
  </o:TableSymbols>
</Model>`;

    const parsed = parsePowerDesignerXml(xml);
    const model = normalizeModel(parsed, 'demo');

    expect(model.tables).toHaveLength(2);
    expect(model.tables[0].columns[0].name).toBe('CustomerID');
    expect(model.tables[0].primaryKey).toContain('column-0');
    expect(model.references[0].name).toBe('FK_Order_Customer');
    expect(model.references[0].parentTable).toBe(model.tables[0].id);
    expect(model.references[0].childTable).toBe(model.tables[1].id);
    expect(model.references[0].joins[0].parentColumn).toBe(model.tables[0].columns[0].id);
    expect(model.references[0].joins[0].childColumn).toBe(model.tables[1].columns[0].id);
    expect(model.tables[0].position).toMatchObject({ x: 120, y: 80, w: 220, h: 160 });
  });
});
