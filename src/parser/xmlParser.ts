import { XMLParser } from 'fast-xml-parser';

export function parsePowerDesignerXml(xmlText: string): Record<string, unknown> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: false,
    allowBooleanAttributes: true,
  });

  const parsed = parser.parse(xmlText);
  return (parsed as Record<string, unknown>) ?? {};
}
