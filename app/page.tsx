"use client";

import { useMemo, useState } from "react";

type ParsedVat = {
  original: string;
  cleaned: string;
  countryCode: string;
  vatNumber: string;
  status: "READY" | "FORMAT_ERROR";
  message: string;
};

type AuditLogRecord = {
  recordId: string;
  batchId: string;
  toolVersion: string;
  requesterVat: string;
  targetVat: string;
  attempt: number;
  dateTime: string;
  countryCode: string;
  vatNumber: string;
  soapAction: string;
  addressLocation: string;
  validationVat: string;
  soapResult: string;
  consultationNumber: string;
  rawRequestIdentifier: string;
  requestDurationMs: number;
  source: string;
  retryReason: string;
  finalOutcomeForThisVat: string;
  companyName: string;
  companyAddress: string;
  httpStatus?: number;
  errorMessage?: string;
};

type ApiResult = {
  checkResult: "VALID" | "INVALID" | "UNAVAILABLE";
  countryCode: string;
  vatNumber: string;
  companyName: string;
  companyAddress: string;
  checkDate: string;
  consultationNumber: string;
  consultationNumberAvailable: boolean;
  requesterVat: string;
  source: string;
  message: string;
  attempts: number;
  auditLog: AuditLogRecord[];
};

function parseVat(raw: string): ParsedVat {
  const cleaned = raw.replace(/[\s.\-]/g, "").toUpperCase();
  const countryCode = cleaned.slice(0, 2);
  const vatNumber = cleaned.slice(2);

  const hasMinLength = cleaned.length >= 4;
  const hasValidCountryCode = /^[A-Z]{2}$/.test(countryCode);
  const hasVatBody = /^[A-Z0-9]+$/.test(vatNumber) && vatNumber.length > 0;

  if (!hasMinLength || !hasValidCountryCode || !hasVatBody) {
    return {
      original: raw,
      cleaned,
      countryCode: "",
      vatNumber: "",
      status: "FORMAT_ERROR",
      message: "Input does not look like a valid VAT format.",
    };
  }

  return {
    original: raw,
    cleaned,
    countryCode,
    vatNumber,
    status: "READY",
    message: "Ready to validate.",
  };
}

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function buildFileName(input: string, fallbackPrefix: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return `${fallbackPrefix}-${getTodayString()}.csv`;
  }

  const safeName = trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").trim();
  return safeName.endsWith(".csv") ? safeName : `${safeName}.csv`;
}

function downloadCsv(
  rows: (string | number | boolean)[][],
  fileName: string
) {
  const csvContent =
    "\uFEFF" +
    rows
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.setAttribute("download", fileName);

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

function getPriority(status: string) {
  if (status === "FORMAT_ERROR") return 0;
  if (status === "UNAVAILABLE") return 1;
  if (status === "INVALID") return 2;
  if (status === "VALID") return 3;
  return 4;
}

export default function Home() {
  const [requesterVat, setRequesterVat] = useState("");
  const [showRequesterNote, setShowRequesterNote] = useState(false);
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [results, setResults] = useState<ApiResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [exportFileName, setExportFileName] = useState("");
  const [logbookFileName, setLogbookFileName] = useState("");

  const parsedVats = useMemo(() => {
    return submitted
      .map((item) => item.trim())
      .filter(Boolean)
      .map(parseVat);
  }, [submitted]);

  const summary = useMemo(() => {
    let totalInput = parsedVats.length;
    let successCount = 0;
    let invalidCount = 0;
    let unavailableCount = 0;
    let formatErrorCount = 0;

    for (const vat of parsedVats) {
      if (vat.status === "FORMAT_ERROR") {
        formatErrorCount += 1;
        continue;
      }

      const result = results.find(
        (r) => `${r.countryCode}${r.vatNumber}` === vat.cleaned
      );

      if (!result) continue;

      if (result.checkResult === "VALID") successCount += 1;
      if (result.checkResult === "INVALID") invalidCount += 1;
      if (result.checkResult === "UNAVAILABLE") unavailableCount += 1;
    }

    return {
      totalInput,
      successCount,
      invalidCount,
      unavailableCount,
      formatErrorCount,
    };
  }, [parsedVats, results]);

  const displayRows = useMemo(() => {
    const rows = parsedVats.map((vat) => {
      const result = results.find(
        (r) => `${r.countryCode}${r.vatNumber}` === vat.cleaned
      );

      const finalStatus =
        vat.status === "FORMAT_ERROR"
          ? "FORMAT_ERROR"
          : result?.checkResult || "WAITING";

      const finalMessage =
        vat.status === "FORMAT_ERROR"
          ? vat.message
          : result
          ? result.message
          : isLoading
          ? "Waiting for API response..."
          : "No API result yet.";

      return {
        vat,
        result,
        finalStatus,
        finalMessage,
      };
    });

    return rows.sort((a, b) => {
      const priorityA = getPriority(a.finalStatus);
      const priorityB = getPriority(b.finalStatus);

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      return a.vat.cleaned.localeCompare(b.vat.cleaned);
    });
  }, [parsedVats, results, isLoading]);

  async function handleValidate() {
    const lines = input
      .split(/\r?\n|,|;/)
      .map((item) => item.trim())
      .filter(Boolean);

    setSubmitted(lines);
    setResults([]);
    setApiError("");

    const parsedRequester = parseVat(requesterVat);

    if (!requesterVat.trim()) {
      setApiError("Requester VAT is required before validation can start.");
      return;
    }

    if (parsedRequester.status === "FORMAT_ERROR") {
      setApiError("Requester VAT must be in a valid VAT format.");
      return;
    }

    const readyVats = lines
      .map(parseVat)
      .filter((v) => v.status === "READY")
      .map((v) => v.cleaned);

    if (readyVats.length === 0) {
      return;
    }

    try {
      setIsLoading(true);

      const res = await fetch("/api/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requesterVat: parsedRequester.cleaned,
          vats: readyVats,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          data?.error || `API request failed with status ${res.status}`
        );
      }

      setResults(data?.results || []);
    } catch (error) {
      console.error(error);
      setApiError(
        error instanceof Error
          ? error.message
          : "Failed to validate VAT numbers."
      );
    } finally {
      setIsLoading(false);
    }
  }

  function handleClear() {
    setRequesterVat("");
    setInput("");
    setSubmitted([]);
    setResults([]);
    setApiError("");
    setIsLoading(false);
  }

  function getStatusStyle(status: string) {
    if (status === "VALID") {
      return {
        color: "#137333",
        backgroundColor: "#e6f4ea",
        fontWeight: "bold" as const,
        padding: "4px 8px",
        borderRadius: "999px",
        display: "inline-block",
      };
    }

    if (status === "INVALID") {
      return {
        color: "#b3261e",
        backgroundColor: "#fce8e6",
        fontWeight: "bold" as const,
        padding: "4px 8px",
        borderRadius: "999px",
        display: "inline-block",
      };
    }

    if (status === "UNAVAILABLE") {
      return {
        color: "#b06000",
        backgroundColor: "#fff4e5",
        fontWeight: "bold" as const,
        padding: "4px 8px",
        borderRadius: "999px",
        display: "inline-block",
      };
    }

    if (status === "FORMAT_ERROR") {
      return {
        color: "#5f6368",
        backgroundColor: "#f1f3f4",
        fontWeight: "bold" as const,
        padding: "4px 8px",
        borderRadius: "999px",
        display: "inline-block",
      };
    }

    return {
      color: "#5f6368",
      backgroundColor: "#f1f3f4",
      fontWeight: "bold" as const,
      padding: "4px 8px",
      borderRadius: "999px",
      display: "inline-block",
    };
  }

  function handleExportResult() {
    if (displayRows.length === 0) return;

    const headers = [
      "Check Result",
      "Country Code",
      "VAT Number",
      "Company Name",
      "Company Address",
      "Check Date",
      "Consultation Number",
      "Consultation Number Available",
      "Requester VAT",
      "Source",
      "Message",
      "Attempts",
    ];

    const rows = displayRows.map(({ vat, result, finalStatus, finalMessage }) => [
      finalStatus,
      vat.countryCode,
      vat.vatNumber,
      result?.companyName || "",
      result?.companyAddress || "",
      result?.checkDate || "",
      result?.consultationNumber || "",
      result?.consultationNumberAvailable ?? "",
      result?.requesterVat ||
        (requesterVat ? parseVat(requesterVat).cleaned : ""),
      result?.source || "",
      finalMessage,
      result?.attempts || "",
    ]);

    downloadCsv(
      [headers, ...rows],
      buildFileName(exportFileName, "vat-checker")
    );
  }

  function handleExportLogbook() {
    const allLogs = results.flatMap((result) => result.auditLog || []);

    if (allLogs.length === 0) return;

    const sortedLogs = [...allLogs].sort((a, b) => {
      const priorityA =
        a.soapResult === "NETWORK_ERROR" ||
        a.soapResult === "HTTP_ERROR" ||
        a.soapResult === "SOAP_FAULT"
          ? 0
          : a.soapResult === "INVALID VAT"
          ? 1
          : a.soapResult === "VALID VAT"
          ? 2
          : 3;

      const priorityB =
        b.soapResult === "NETWORK_ERROR" ||
        b.soapResult === "HTTP_ERROR" ||
        b.soapResult === "SOAP_FAULT"
          ? 0
          : b.soapResult === "INVALID VAT"
          ? 1
          : b.soapResult === "VALID VAT"
          ? 2
          : 3;

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      return a.targetVat.localeCompare(b.targetVat);
    });

    const headers = [
      "Record ID",
      "Batch ID",
      "Tool Version",
      "Requester VAT",
      "Target VAT",
      "Attempt",
      "Date and Time",
      "Country Code",
      "VAT Number",
      "SOAP Action",
      "Address Location",
      "Validation VAT (SOAP)",
      "SOAP Result",
      "Consultation Number",
      "Raw Request Identifier",
      "Request Duration Ms",
      "Retry Reason",
      "Final Outcome For This VAT",
      "Company Name",
      "Company Address",
      "Source",
      "HTTP Status",
      "Error Message",
    ];

    const rows = sortedLogs.map((log) => [
      log.recordId,
      log.batchId,
      log.toolVersion,
      log.requesterVat,
      log.targetVat,
      log.attempt,
      log.dateTime,
      log.countryCode,
      log.vatNumber,
      log.soapAction,
      log.addressLocation,
      log.validationVat,
      log.soapResult,
      log.consultationNumber,
      log.rawRequestIdentifier,
      log.requestDurationMs,
      log.retryReason,
      log.finalOutcomeForThisVat,
      log.companyName,
      log.companyAddress,
      log.source,
      log.httpStatus ?? "",
      log.errorMessage ?? "",
    ]);

    downloadCsv(
      [headers, ...rows],
      buildFileName(logbookFileName, "logbook")
    );
  }

  return (
    <main
      style={{
        padding: "40px",
        fontFamily: "Arial, sans-serif",
        maxWidth: "1360px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: "32px", marginBottom: "8px" }}>
        VAT Batch Checker V3
      </h1>

      <p style={{ color: "#555", marginBottom: "12px" }}>
        VIES-based VAT validation with requester VAT, consultation number, retry,
        summary cards, and audit log export.
      </p>

      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "6px",
            fontWeight: 600,
          }}
        >
          <span>Requester VAT</span>
          <button
            type="button"
            onClick={() => setShowRequesterNote((prev) => !prev)}
            style={infoButtonStyle}
          >
            i
          </button>
        </label>

        {showRequesterNote ? (
          <p
            style={{
              fontSize: "12px",
              color: "#666",
              marginTop: "0",
              marginBottom: "8px",
              lineHeight: 1.5,
            }}
          >
            Requester VAT is the VAT number of the party requesting the
            validation. It is required because VIES consultation number logic
            depends on the requester information. Without requester VAT, the
            validation step will not start. Please use the VAT number of the
            entity that needs the validation evidence, not just the target VAT
            being checked.
          </p>
        ) : null}

        <input
          value={requesterVat}
          onChange={(e) => setRequesterVat(e.target.value)}
          placeholder="Example: DE123456789"
          style={inputStyle}
        />
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={`DE123456789
NL123456789B01
BE0123456789`}
        style={{
          width: "100%",
          minHeight: "220px",
          padding: "12px",
          fontSize: "16px",
          lineHeight: 1.5,
          border: "1px solid #ccc",
          borderRadius: "8px",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(120px, 1fr))",
          gap: "12px",
          marginTop: "20px",
        }}
      >
        <div style={statCardStyle}>
          <div style={statLabelStyle}>Input</div>
          <div style={statValueStyle}>{summary.totalInput}</div>
        </div>

        <div style={statCardStyle}>
          <div style={statLabelStyle}>Success</div>
          <div style={statValueStyle}>{summary.successCount}</div>
        </div>

        <div style={statCardStyle}>
          <div style={statLabelStyle}>Invalid</div>
          <div style={statValueStyle}>{summary.invalidCount}</div>
        </div>

        <div style={statCardStyle}>
          <div style={statLabelStyle}>Unavailable</div>
          <div style={statValueStyle}>{summary.unavailableCount}</div>
        </div>

        <div style={statCardStyle}>
          <div style={statLabelStyle}>Format Error</div>
          <div style={statValueStyle}>{summary.formatErrorCount}</div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          marginTop: "20px",
        }}
      >
        <div>
          <label
            style={{ display: "block", marginBottom: "6px", fontWeight: 600 }}
          >
            Export Result file name
          </label>
          <input
            value={exportFileName}
            onChange={(e) => setExportFileName(e.target.value)}
            placeholder="Optional. Default: vat-checker-YYYY-MM-DD.csv"
            style={inputStyle}
          />
        </div>

        <div>
          <label
            style={{ display: "block", marginBottom: "6px", fontWeight: 600 }}
          >
            Export Logbook file name
          </label>
          <input
            value={logbookFileName}
            onChange={(e) => setLogbookFileName(e.target.value)}
            placeholder="Optional. Default: logbook-YYYY-MM-DD.csv"
            style={inputStyle}
          />
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: "12px",
          marginTop: "20px",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={handleValidate}
          disabled={isLoading}
          style={buttonStyle}
        >
          {isLoading ? "Validating..." : "Validate"}
        </button>

        <button onClick={handleClear} style={buttonStyle}>
          Clear
        </button>

        <button onClick={handleExportResult} style={buttonStyle}>
          Export Result
        </button>

        <button onClick={handleExportLogbook} style={buttonStyle}>
          Export Logbook
        </button>
      </div>

      {apiError ? (
        <p style={{ marginTop: "16px", color: "crimson" }}>{apiError}</p>
      ) : null}

      <section style={{ marginTop: "32px" }}>
        <h2 style={{ fontSize: "24px", marginBottom: "12px" }}>Results</h2>

        {displayRows.length === 0 ? (
          <p style={{ color: "#666" }}>No VAT numbers processed yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: "1600px",
              }}
            >
              <thead>
                <tr>
                  <th style={thStyle}>Original Input</th>
                  <th style={thStyle}>Country Code</th>
                  <th style={thStyle}>VAT Number</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Company Name</th>
                  <th style={thStyle}>Company Address</th>
                  <th style={thStyle}>Check Date</th>
                  <th style={thStyle}>Consultation Number</th>
                  <th style={thStyle}>Consultation Available</th>
                  <th style={thStyle}>Requester VAT</th>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Attempts</th>
                  <th style={thStyle}>Message</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map(
                  ({ vat, result, finalStatus, finalMessage }, index) => (
                    <tr key={`${vat.cleaned}-${index}`}>
                      <td style={tdStyle}>{vat.original}</td>
                      <td style={tdStyle}>{vat.countryCode}</td>
                      <td style={tdStyle}>{vat.vatNumber}</td>
                      <td style={tdStyle}>
                        <span style={getStatusStyle(finalStatus)}>
                          {finalStatus}
                        </span>
                      </td>
                      <td style={tdStyle}>{result?.companyName || "-"}</td>
                      <td style={tdStyle}>{result?.companyAddress || "-"}</td>
                      <td style={tdStyle}>{result?.checkDate || "-"}</td>
                      <td style={tdStyle}>
                        {result?.consultationNumber || "-"}
                      </td>
                      <td style={tdStyle}>
                        {typeof result?.consultationNumberAvailable === "boolean"
                          ? String(result.consultationNumberAvailable)
                          : "-"}
                      </td>
                      <td style={tdStyle}>
                        {result?.requesterVat ||
                          (requesterVat ? parseVat(requesterVat).cleaned : "-")}
                      </td>
                      <td style={tdStyle}>{result?.source || "-"}</td>
                      <td style={tdStyle}>{result?.attempts || "-"}</td>
                      <td style={tdStyle}>{finalMessage}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        style={{
          marginTop: "32px",
          borderTop: "1px solid #eee",
          paddingTop: "20px",
          color: "#666",
          lineHeight: 1.6,
          fontSize: "14px",
        }}
      >
        <p>
          Disclaimer: This tool is connected to the VIES-based validation source.
          Results depend on the availability and accuracy of VIES and related
          responses.
        </p>
        <p>
          The author of this website does not guarantee completeness, accuracy,
          or uninterrupted availability of the results and is not responsible for
          any direct or indirect reliance on them.
        </p>
        <p>
          This website is provided for internal/testing/reference purposes only
          and should not be treated as a standalone commercial compliance
          product. All API-based validation data originates from the
          VIES-connected service. Please review and verify all results
          independently.
        </p>
      </section>
    </main>
  );
}

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "14px",
  border: "1px solid #ccc",
  borderRadius: "8px",
  boxSizing: "border-box" as const,
};

const buttonStyle = {
  padding: "10px 18px",
  fontSize: "16px",
  border: "1px solid #ccc",
  borderRadius: "8px",
  cursor: "pointer",
  background: "#fff",
};

const infoButtonStyle = {
  width: "18px",
  height: "18px",
  borderRadius: "999px",
  border: "1px solid #bbb",
  background: "#fff",
  color: "#666",
  fontSize: "12px",
  lineHeight: "16px",
  cursor: "pointer",
  padding: 0,
};

const statCardStyle = {
  border: "1px solid #ddd",
  borderRadius: "10px",
  padding: "14px",
  background: "#fafafa",
};

const statLabelStyle = {
  fontSize: "13px",
  color: "#666",
  marginBottom: "6px",
};

const statValueStyle = {
  fontSize: "24px",
  fontWeight: "bold" as const,
};

const thStyle = {
  textAlign: "left" as const,
  borderBottom: "1px solid #ccc",
  padding: "10px",
  background: "#f7f7f7",
};

const tdStyle = {
  borderBottom: "1px solid #eee",
  padding: "10px",
  verticalAlign: "top" as const,
};