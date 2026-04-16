import { NextResponse } from "next/server";
import crypto from "crypto";

type ValidationStatus = "VALID" | "INVALID" | "UNAVAILABLE";

type AuditRecord = {
  recordId: string;
  batchId: string;
  toolVersion: string;
  requesterVat: string;
  targetVat: string;
  attempt: number;
  dateTime: string;
  countryCode: string;
  vatNumber: string;
  soapAction: "checkVatApprox";
  addressLocation: string;
  validationVat: string;
  soapResult: string;
  consultationNumber: string;
  rawRequestIdentifier: string;
  requestDurationMs: number;
  source: "VIES";
  retryReason: string;
  finalOutcomeForThisVat: ValidationStatus | "";
  companyName: string;
  companyAddress: string;
  httpStatus?: number;
  errorMessage?: string;
};

type ValidationResult = {
  checkResult: ValidationStatus;
  countryCode: string;
  vatNumber: string;
  companyName: string;
  companyAddress: string;
  checkDate: string;
  consultationNumber: string;
  consultationNumberAvailable: boolean;
  requesterVat: string;
  source: "VIES";
  message: string;
  attempts: number;
  auditLog: AuditRecord[];
};

const TOOL_VERSION = "V3.3";
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

function normalizeReturnedField(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "---") return "";
  return cleaned;
}

function buildAddressLocation(name: string, address: string) {
  const parts = [name, address].filter(Boolean);
  return parts.join(" | ");
}

function parseVatParts(vat: string) {
  const cleaned = vat.replace(/[\s.\-]/g, "").toUpperCase();
  return {
    cleaned,
    countryCode: cleaned.slice(0, 2),
    vatNumber: cleaned.slice(2),
  };
}

function isLikelyViesConsultationNumber(value: string) {
  if (!value) return false;

  const trimmed = value.trim();

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidRegex.test(trimmed)) {
    return false;
  }

  const viesLikeRegex = /^[A-Za-z0-9]{8,40}$/;
  return viesLikeRegex.test(trimmed);
}

function sanitizeConsultationNumber(rawValue: string) {
  return isLikelyViesConsultationNumber(rawValue) ? rawValue.trim() : "";
}

type CallResult =
  | {
      success: true;
      result: Omit<ValidationResult, "auditLog">;
      auditRecord: AuditRecord;
    }
  | {
      success: false;
      message: string;
      auditRecord: AuditRecord;
    };

async function callViesOnce(
  batchId: string,
  requesterVat: string,
  targetVat: string,
  attempt: number
): Promise<CallResult> {
  const start = Date.now();
  const dateTime = new Date().toISOString();

  const requester = parseVatParts(requesterVat);
  const target = parseVatParts(targetVat);

  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVatApprox>
      <urn:countryCode>${escapeXml(target.countryCode)}</urn:countryCode>
      <urn:vatNumber>${escapeXml(target.vatNumber)}</urn:vatNumber>
      <urn:requesterCountryCode>${escapeXml(
        requester.countryCode
      )}</urn:requesterCountryCode>
      <urn:requesterVatNumber>${escapeXml(
        requester.vatNumber
      )}</urn:requesterVatNumber>
    </urn:checkVatApprox>
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
    const requestDurationMs = Date.now() - start;

    if (!response.ok) {
      const faultString =
        extractTagValue(xml, "faultstring") ||
        `HTTP ${response.status} from VIES`;

      const rawRequestIdentifier = extractTagValue(xml, "requestIdentifier");
      const consultationNumber = sanitizeConsultationNumber(rawRequestIdentifier);

      const auditRecord: AuditRecord = {
        recordId: crypto.randomUUID(),
        batchId,
        toolVersion: TOOL_VERSION,
        requesterVat,
        targetVat,
        attempt,
        dateTime,
        countryCode: target.countryCode,
        vatNumber: target.vatNumber,
        soapAction: "checkVatApprox",
        addressLocation: "",
        validationVat: targetVat,
        soapResult: "HTTP_ERROR",
        consultationNumber,
        rawRequestIdentifier,
        requestDurationMs,
        source: "VIES",
        retryReason: "",
        finalOutcomeForThisVat: "",
        companyName: "",
        companyAddress: "",
        httpStatus: response.status,
        errorMessage: faultString,
      };

      return {
        success: false,
        message: faultString,
        auditRecord,
      };
    }

    const faultString = extractTagValue(xml, "faultstring");
    if (faultString) {
      const rawRequestIdentifier = extractTagValue(xml, "requestIdentifier");
      const consultationNumber = sanitizeConsultationNumber(rawRequestIdentifier);

      const auditRecord: AuditRecord = {
        recordId: crypto.randomUUID(),
        batchId,
        toolVersion: TOOL_VERSION,
        requesterVat,
        targetVat,
        attempt,
        dateTime,
        countryCode: target.countryCode,
        vatNumber: target.vatNumber,
        soapAction: "checkVatApprox",
        addressLocation: "",
        validationVat: targetVat,
        soapResult: "SOAP_FAULT",
        consultationNumber,
        rawRequestIdentifier,
        requestDurationMs,
        source: "VIES",
        retryReason: "",
        finalOutcomeForThisVat: "",
        companyName: "",
        companyAddress: "",
        errorMessage: faultString,
      };

      return {
        success: false,
        message: faultString,
        auditRecord,
      };
    }

    const validRaw = extractTagValue(xml, "valid");
    const traderNameRaw =
      extractTagValue(xml, "traderName") || extractTagValue(xml, "name");
    const traderAddressRaw =
      extractTagValue(xml, "traderAddress") || extractTagValue(xml, "address");
    const rawRequestIdentifier = extractTagValue(xml, "requestIdentifier");
    const consultationNumber = sanitizeConsultationNumber(rawRequestIdentifier);

    const isValid = validRaw.toLowerCase() === "true";
    const companyName = normalizeReturnedField(traderNameRaw);
    const companyAddress = normalizeReturnedField(traderAddressRaw);

    const auditRecord: AuditRecord = {
      recordId: crypto.randomUUID(),
      batchId,
      toolVersion: TOOL_VERSION,
      requesterVat,
      targetVat,
      attempt,
      dateTime,
      countryCode: target.countryCode,
      vatNumber: target.vatNumber,
      soapAction: "checkVatApprox",
      addressLocation: buildAddressLocation(companyName, companyAddress),
      validationVat: targetVat,
      soapResult: isValid ? "VALID VAT" : "INVALID VAT",
      consultationNumber,
      rawRequestIdentifier,
      requestDurationMs,
      source: "VIES",
      retryReason: "",
      finalOutcomeForThisVat: "",
      companyName,
      companyAddress,
    };

    return {
      success: true,
      result: {
        checkResult: isValid ? "VALID" : "INVALID",
        countryCode: target.countryCode,
        vatNumber: target.vatNumber,
        companyName,
        companyAddress,
        checkDate: dateTime,
        consultationNumber,
        consultationNumberAvailable: Boolean(consultationNumber),
        requesterVat,
        source: "VIES",
        message: isValid
          ? consultationNumber
            ? "Validation completed."
            : "Validation completed, but consultation number unavailable."
          : "Invalid VAT number.",
        attempts: attempt,
      },
      auditRecord,
    };
  } catch (error) {
    const requestDurationMs = Date.now() - start;
    const message =
      error instanceof Error ? error.message : "Unknown network error";

    const auditRecord: AuditRecord = {
      recordId: crypto.randomUUID(),
      batchId,
      toolVersion: TOOL_VERSION,
      requesterVat,
      targetVat,
      attempt,
      dateTime,
      countryCode: target.countryCode,
      vatNumber: target.vatNumber,
      soapAction: "checkVatApprox",
      addressLocation: "",
      validationVat: targetVat,
      soapResult: "NETWORK_ERROR",
      consultationNumber: "",
      rawRequestIdentifier: "",
      requestDurationMs,
      source: "VIES",
      retryReason: "",
      finalOutcomeForThisVat: "",
      companyName: "",
      companyAddress: "",
      errorMessage: message,
    };

    return {
      success: false,
      message,
      auditRecord,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateViaViesWithRetry(
  batchId: string,
  requesterVat: string,
  targetVat: string
): Promise<ValidationResult> {
  const auditLog: AuditRecord[] = [];
  let lastErrorMessage = "VIES unavailable after retries.";
  const target = parseVatParts(targetVat);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callViesOnce(batchId, requesterVat, targetVat, attempt);

    if (result.success) {
      const needsConsultationRetry =
        result.result.checkResult === "VALID" &&
        !result.result.consultationNumberAvailable;

      result.auditRecord.retryReason = needsConsultationRetry
        ? "missing_consultation_number"
        : "";

      auditLog.push(result.auditRecord);

      if (!needsConsultationRetry) {
        auditLog[auditLog.length - 1].finalOutcomeForThisVat =
          result.result.checkResult;

        return {
          ...result.result,
          auditLog,
        };
      }

      lastErrorMessage = "Validation completed, but consultation number unavailable.";
    } else {
      result.auditRecord.retryReason = "request_failed";
      auditLog.push(result.auditRecord);
      lastErrorMessage = result.message;
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (auditLog.length > 0) {
    const lastSuccessWithoutConsultation = auditLog.some(
      (log) => log.soapResult === "VALID VAT"
    );

    if (lastSuccessWithoutConsultation) {
      auditLog[auditLog.length - 1].finalOutcomeForThisVat = "VALID";

      return {
        checkResult: "VALID",
        countryCode: target.countryCode,
        vatNumber: target.vatNumber,
        companyName: "",
        companyAddress: "",
        checkDate: new Date().toISOString(),
        consultationNumber: "",
        consultationNumberAvailable: false,
        requesterVat,
        source: "VIES",
        message: "Validation completed, but consultation number unavailable.",
        attempts: MAX_RETRIES,
        auditLog,
      };
    }

    auditLog[auditLog.length - 1].finalOutcomeForThisVat = "UNAVAILABLE";
  }

  return {
    checkResult: "UNAVAILABLE",
    countryCode: target.countryCode,
    vatNumber: target.vatNumber,
    companyName: "",
    companyAddress: "",
    checkDate: new Date().toISOString(),
    consultationNumber: "",
    consultationNumberAvailable: false,
    requesterVat,
    source: "VIES",
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

    const requesterVat =
      typeof body?.requesterVat === "string" ? body.requesterVat.trim() : "";

    const vats: string[] = Array.isArray(body?.vats) ? body.vats : [];

    if (!requesterVat) {
      return NextResponse.json(
        { error: "requesterVat is required" },
        { status: 400 }
      );
    }

    const batchId = crypto.randomUUID();
    const uniqueVats = [...new Set(vats)];

    const results = await Promise.all(
      uniqueVats.map((vat) =>
        validateViaViesWithRetry(batchId, requesterVat, vat)
      )
    );

    return NextResponse.json({ results, batchId });
  } catch (error) {
    console.error("API error:", error);

    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}