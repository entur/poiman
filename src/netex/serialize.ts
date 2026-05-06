export type NetexPoi = {
  id: number;
  name: string;
  poi_type: string;
  longitude: number;
  latitude: number;
  valid_from: Date;
  valid_to: Date;
};

const OSLO_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatOsloIso(d: Date): string {
  return OSLO_FMT.format(d).replace(" ", "T");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function poiBlock(p: NetexPoi): string {
  const name = escapeXml(p.name);
  return [
    `                <TopographicPlace id="ENT:TopographicPlace:${p.id}" version="1">`,
    `                    <ValidBetween>`,
    `                        <FromDate>${formatOsloIso(p.valid_from)}</FromDate>`,
    `                        <ToDate>${formatOsloIso(p.valid_to)}</ToDate>`,
    `                    </ValidBetween>`,
    `                    <keyList>`,
    `                        <KeyValue>`,
    `                            <Key>custom_poi</Key>`,
    `                            <Value>${escapeXml(p.poi_type)}</Value>`,
    `                        </KeyValue>`,
    `                    </keyList>`,
    `                    <Name>${name}</Name>`,
    `                    <Centroid>`,
    `                        <Location>`,
    `                            <Longitude>${p.longitude}</Longitude>`,
    `                            <Latitude>${p.latitude}</Latitude>`,
    `                        </Location>`,
    `                    </Centroid>`,
    `                    <Descriptor>`,
    `                        <Name>${name}</Name>`,
    `                    </Descriptor>`,
    `                    <TopographicPlaceType>placeOfInterest</TopographicPlaceType>`,
    `                </TopographicPlace>`,
  ].join("\n");
}

export function serializeNetex(pois: NetexPoi[], now: Date = new Date()): string {
  const ts = formatOsloIso(now);
  const places =
    pois.length === 0
      ? ""
      : "\n" + pois.map(poiBlock).join("\n");
  return [
    `<?xml version='1.0' encoding='utf-8'?>`,
    `<PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="1.5">`,
    `    <PublicationTimestamp>${ts}</PublicationTimestamp>`,
    `    <ParticipantRef>ENT</ParticipantRef>`,
    `    <Description>Enturs markedsavdelings-NeTEx</Description>`,
    `    <dataObjects>`,
    `        <SiteFrame version="1" id="ENT:SiteFrame:1">`,
    `            <ValidBetween>`,
    `                <FromDate>${ts}</FromDate>`,
    `            </ValidBetween>`,
    `            <codespaces>`,
    `                <Codespace id="ENT">`,
    `                    <Xmlns>ENT</Xmlns>`,
    `                    <XmlnsUrl>http://www.rutebanken.org/ns/ent</XmlnsUrl>`,
    `                </Codespace>`,
    `            </codespaces>`,
    `            <FrameDefaults>`,
    `                <DefaultLocale>`,
    `                    <TimeZone>Europe/Oslo</TimeZone>`,
    `                    <DefaultLanguage>no</DefaultLanguage>`,
    `                </DefaultLocale>`,
    `            </FrameDefaults>`,
    `            <topographicPlaces>${places}`,
    `            </topographicPlaces>`,
    `        </SiteFrame>`,
    `    </dataObjects>`,
    `</PublicationDelivery>`,
  ].join("\n");
}
