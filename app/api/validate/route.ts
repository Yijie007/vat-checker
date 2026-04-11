import { NextResponse } from "next/server";

type ValidationStatus = "VALID" | "INVALID" | "UNAVAILABLE";

type AuditRecord = {
  vat: string;
  attempt: number;
  dateTime: string;
  addressLocation: string;
  validationVat: string;
  soapResult: string;
  source: "VIES";
  httpStatus?: number;
  errorMessage?: string;
};

type ValidationResult = {
  vat: string;
  status: ValidationStatus;
  name: string;
  address: string;
  source: "VIES";
  checkedAt: string;
  message: string;
  attempts: number;
  auditLog: AuditRecord[];
};

const VIES_ENDPOINT =
  "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";

const MAX_RETRIES = 15;
const RETRY_DELAY_MS = 1200;
const REQUEST_TIMEOUT_MS = 15000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function buildAddressLocation(name: string, address: string) {
  const parts = [name, address].filter(Boolean);
  return parts.join(" | ");
}

async function callViesOnce(
  vat: string,
  attempt: number
): Promise<
  | {
      success: true;
      result: Omit<ValidationResult, "auditLog">;
      auditRecord: AuditRecord;
    }
  | {
      success: false;
      retryable: true;
      message: string;
      auditRecord: AuditRecord;
    }
> {
  const dateTime = new Date().toISOString();

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
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

      const auditRecord: AuditRecord = {
        vat,
        attempt,
        dateTime,
        addressLocation: "",
        validationVat: vat,
        soapResult: "HTTP_ERROR",
        source: "VIES",
        httpStatus: response.status,
        errorMessage: faultString,
      };

      return {
        success: false,
        retryable: true,
        message: faultString,
        auditRecord,
      };
    }

    const faultString = extractTagValue(xml, "faultstring");
    if (faultString) {
      const auditRecord: AuditRecord = {
        vat,
        attempt,
        dateTime,
        addressLocation: "",
        validationVat: vat,
        soapResult: "SOAP_FAULT",
        source: "VIES",
        errorMessage: faultString,
      };

      return {
        success: false,
        retryable: true,
        message: faultString,
        auditRecord,
      };
    }

    const validRaw = extractTagValue(xml, "valid");
    const nameRaw = extractTagValue(xml, "name");
    const addressRaw = extractTagValue(xml, "address");

    const isValid = validRaw.toLowerCase() === "true";
    const name = normalizeReturnedField(nameRaw);
    const address = normalizeReturnedField(addressRaw);

    const auditRecord: AuditRecord = {
      vat,
      attempt,
      dateTime,
      addressLocation: buildAddressLocation(name, address),
      validationVat: vat,
      soapResult: isValid ? "VALID VAT" : "INVALID VAT",
      source: "VIES",
    };

    return {
      success: true,
      result: {
        vat,
        status: isValid ? "VALID" : "INVALID",
        name,
        address,
        source: "VIES",
        checkedAt: dateTime,
        message: isValid
          ? "Validation completed."
          : "Invalid VAT number.",
        attempts: attempt,
      },
      auditRecord,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown network error";

    const auditRecord: AuditRecord = {
      vat,
      attempt,
      dateTime,
      addressLocation: "",
      validationVat: vat,
      soapResult: "NETWORK_ERROR",
      source: "VIES",
      errorMessage: message,
    };

    return {
      success: false,
      retryable: true,
      message,
      auditRecord,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateViaViesWithRetry(vat: string): Promise<ValidationResult> {
  const auditLog: AuditRecord[] = [];
  let lastErrorMessage = "VIES unavailable after retries.";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callViesOnce(vat, attempt);
    auditLog.push(result.auditRecord);

    if (result.success) {
      return {
        ...result.result,
        auditLog,
      };
    }

    lastErrorMessage = result.message;

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  return {
    vat,
    status: "UNAVAILABLE",
    name: "",
    address: "",
    source: "VIES",
    checkedAt: new Date().toISOString(),
    message: lastErrorMessage,
    attempts: MAX_RETRIES,
    auditLog,
  };
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

    const results = await Promise.all(
      uniqueVats.map((vat) => validateViaViesWithRetry(vat))
    );

    return NextResponse.json({ results });
  } catch (error) {
    console.error("API error:", error);

    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}