import { NextResponse } from "next/server";

type ValidationResult = {
  vat: string;
  status: "VALID" | "INVALID" | "UNAVAILABLE";
  name: string;
  address: string;
  source: "VIES";
  checkedAt: string;
  message: string;
};

const VIES_ENDPOINT =
  "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractTagValue(xml: string, tagName: string): string {
  const regex = new RegExp(
    `<(?:\\w+:)?${tagName}>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`,
    "i"
  );
  const match = xml.match(regex);
  return match?.[1]?.trim() ?? "";
}

function normalizeReturnedField(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "---") return "";
  return cleaned;
}

async function validateViaVies(vat: string): Promise<ValidationResult> {
  const checkedAt = new Date().toISOString();
  const countryCode = vat.slice(0, 2).toUpperCase();
  const vatNumber = vat.slice(2).toUpperCase();

  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVat>
      <urn:countryCode>${escapeXml(countryCode)}</urn:countryCode>
      <urn:vatNumber>${escapeXml(vatNumber)}</urn:vatNumber>
    </urn:checkVat>
  </soapenv:Body>
</soapenv:Envelope>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(VIES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "",
      },
      body: soapEnvelope,
      signal: controller.signal,
      cache: "no-store",
    });

    const xml = await response.text();

    if (!response.ok) {
      const faultString =
        extractTagValue(xml, "faultstring") ||
        `HTTP ${response.status} from VIES`;

      return {
        vat,
        status: "UNAVAILABLE",
        name: "",
        address: "",
        source: "VIES",
        checkedAt,
        message: faultString,
      };
    }

    const validRaw = extractTagValue(xml, "valid");
    const nameRaw = extractTagValue(xml, "name");
    const addressRaw = extractTagValue(xml, "address");
    const faultString = extractTagValue(xml, "faultstring");

    if (faultString) {
      return {
        vat,
        status: "UNAVAILABLE",
        name: "",
        address: "",
        source: "VIES",
        checkedAt,
        message: faultString,
      };
    }

    const isValid = validRaw.toLowerCase() === "true";
    const name = normalizeReturnedField(nameRaw);
    const address = normalizeReturnedField(addressRaw);

    return {
      vat,
      status: isValid ? "VALID" : "INVALID",
      name,
      address,
      source: "VIES",
      checkedAt,
      message: isValid ? "Validation completed." : "Invalid VAT number.",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown VIES error";

    return {
      vat,
      status: "UNAVAILABLE",
      name: "",
      address: "",
      source: "VIES",
      checkedAt,
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "VIES validate API is working",
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const vats: string[] = Array.isArray(body?.vats) ? body.vats : [];

    const uniqueVats = [...new Set(vats)];

    const results = await Promise.all(uniqueVats.map(validateViaVies));

    return NextResponse.json({ results });
  } catch (error) {
    console.error("API error:", error);

    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}