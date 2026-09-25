const { XMLParser } = require('fast-xml-parser');

const xml = `<?xml version="1.0"?>
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
      </c:Columns>
      <o:PrimaryKey>
        <o:Key>
          <o:Column>CustomerID</o:Column>
        </o:Key>
      </o:PrimaryKey>
    </o:Table>
  </o:Tables>
</Model>`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: false,
  allowBooleanAttributes: true,
});

console.log(JSON.stringify(parser.parse(xml), null, 2));
