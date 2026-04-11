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
  vat: string;
  attempt: number;
  dateTime: string;
  addressLocation: string;
  validationVat: string;
  soapResult: string;
  source: string;
  httpStatus?: number;
  errorMessage?: string;
};

type ApiResult = {
  vat: string;
  status: "VALID" | "INVALID" | "UNAVAILABLE";
  name: string;
  address: string;
  source: string;
  checkedAt: string;
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

function downloadCsv(rows: (string | number | boolean)[][], fileName: string) {
  const csvContent = rows
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

export default function Home() {
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

  async function handleValidate() {
    const lines = input
      .split(/\r?\n|,|;/)
      .map((item) => item.trim())
      .filter(Boolean);

    setSubmitted(lines);
    setResults([]);
    setApiError("");

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
        body: JSON.stringify({ vats: readyVats }),
      });

      if (!res.ok) {
        throw new Error(`API request failed with status ${res.status}`);
      }

      const data = await res.json();
      setResults(data.results || []);
    } catch (error) {
      console.error(error);
      setApiError("Failed to validate VAT numbers.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleClear() {
    setInput("");
    setSubmitted([]);
    setResults([]);
    setApiError("");
    setIsLoading(false);
  }

  function getResult(cleanedVat: string) {
    return results.find((r) => r.vat === cleanedVat);
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

  function handleExportCsv() {
    if (parsedVats.length === 0) return;

    const headers = [
      "Original Input",
      "Cleaned VAT",
      "Country Code",
      "VAT Number",
      "Status",
      "Name",
      "Address",
      "Source",
      "Checked At",
      "Attempts",
      "Message",
    ];

    const rows = parsedVats.map((vat) => {
      const result = getResult(vat.cleaned);

      const finalStatus =
        vat.status === "FORMAT_ERROR"
          ? "FORMAT_ERROR"
          : result?.status || "WAITING";

      const finalMessage =
        vat.status === "FORMAT_ERROR"
          ? vat.message
          : result
          ? result.message
          : isLoading
          ? "Waiting for API response..."
          : "No API result yet.";

      return [
        vat.original,
        vat.cleaned,
        vat.countryCode,
        vat.vatNumber,
        finalStatus,
        result?.name || "",
        result?.address || "",
        result?.source || "",
        result?.checkedAt || "",
        result?.attempts || "",
        finalMessage,
      ];
    });

    downloadCsv(
      [headers, ...rows],
      buildFileName(exportFileName, "vat-checker")
    );
  }

  function handleExportLogbook() {
    const allLogs = results.flatMap((result) => result.auditLog || []);

    if (allLogs.length === 0) return;

    const headers = [
      "VAT",
      "Attempt",
      "Date and Time",
      "Address Location",
      "Validation VAT (SOAP)",
      "SOAP Result",
      "Source",
      "HTTP Status",
      "Error Message",
    ];

    const rows = allLogs.map((log) => [
      log.vat,
      log.attempt,
      log.dateTime,
      log.addressLocation,
      log.validationVat,
      log.soapResult,
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
        maxWidth: "1280px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: "32px", marginBottom: "8px" }}>
        VAT Batch Checker
      </h1>

      <p style={{ color: "#555", marginBottom: "20px" }}>
        Paste multiple VAT numbers below, one per line.
      </p>

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
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          marginTop: "20px",
        }}
      >
        <div>
          <label style={{ display: "block", marginBottom: "6px", fontWeight: 600 }}>
            Export CSV file name
          </label>
          <input
            value={exportFileName}
            onChange={(e) => setExportFileName(e.target.value)}
            placeholder="Optional. Default: vat-checker-YYYY-MM-DD.csv"
            style={inputStyle}
          />
        </div>

        <div>
          <label style={{ display: "block", marginBottom: "6px", fontWeight: 600 }}>
            Logbook file name
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

        <button onClick={handleExportCsv} style={buttonStyle}>
          Export CSV
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

        {parsedVats.length === 0 ? (
          <p style={{ color: "#666" }}>No VAT numbers processed yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: "1300px",
              }}
            >
              <thead>
                <tr>
                  <th style={thStyle}>Original Input</th>
                  <th style={thStyle}>Cleaned VAT</th>
                  <th style={thStyle}>Country Code</th>
                  <th style={thStyle}>VAT Number</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Address</th>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Checked At</th>
                  <th style={thStyle}>Attempts</th>
                  <th style={thStyle}>Message</th>
                </tr>
              </thead>
              <tbody>
                {parsedVats.map((vat, index) => {
                  const result = getResult(vat.cleaned);

                  const finalStatus =
                    vat.status === "FORMAT_ERROR"
                      ? "FORMAT_ERROR"
                      : result?.status || "WAITING";

                  const finalMessage =
                    vat.status === "FORMAT_ERROR"
                      ? vat.message
                      : result
                      ? result.message
                      : isLoading
                      ? "Waiting for API response..."
                      : "No API result yet.";

                  return (
                    <tr key={`${vat.cleaned}-${index}`}>
                      <td style={tdStyle}>{vat.original}</td>
                      <td style={tdStyle}>{vat.cleaned}</td>
                      <td style={tdStyle}>{vat.countryCode}</td>
                      <td style={tdStyle}>{vat.vatNumber}</td>
                      <td style={tdStyle}>
                        <span style={getStatusStyle(finalStatus)}>
                          {finalStatus}
                        </span>
                      </td>
                      <td style={tdStyle}>{result?.name || "-"}</td>
                      <td style={tdStyle}>{result?.address || "-"}</td>
                      <td style={tdStyle}>{result?.source || "-"}</td>
                      <td style={tdStyle}>{result?.checkedAt || "-"}</td>
                      <td style={tdStyle}>{result?.attempts || "-"}</td>
                      <td style={tdStyle}>{finalMessage}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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