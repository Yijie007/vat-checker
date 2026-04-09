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

type ApiResult = {
  vat: string;
  status: "VALID" | "INVALID" | "UNAVAILABLE";
  name: string;
  address: string;
  source: string;
  checkedAt: string;
  message: string;
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

export default function Home() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [results, setResults] = useState<ApiResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState("");

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
        finalMessage,
      ];
    });

    const csvContent = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.setAttribute("download", "vat-validation-results.csv");

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  return (
    <main
      style={{
        padding: "40px",
        fontFamily: "Arial, sans-serif",
        maxWidth: "1100px",
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

      <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
        <button
          onClick={handleValidate}
          disabled={isLoading}
          style={{
            padding: "10px 18px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            cursor: "pointer",
            background: "#fff",
          }}
        >
          {isLoading ? "Validating..." : "Validate"}
        </button>

        <button
          onClick={handleClear}
          style={{
            padding: "10px 18px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            cursor: "pointer",
            background: "#fff",
          }}
        >
          Clear
        </button>

        <button
          onClick={handleExportCsv}
          style={{
            padding: "10px 18px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "8px",
            cursor: "pointer",
            background: "#fff",
          }}
        >
          Export CSV
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
                minWidth: "1100px",
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
                      ? "Validation completed."
                      : isLoading
                      ? "Waiting for API response..."
                      : "No API result yet.";

                  return (
                    <tr key={`${vat.cleaned}-${index}`}>
                      <td style={tdStyle}>{vat.original}</td>
                      <td style={tdStyle}>{vat.cleaned}</td>
                      <td style={tdStyle}>{vat.countryCode}</td>
                      <td style={tdStyle}>{vat.vatNumber}</td>
                      <td style={tdStyle}>{finalStatus}</td>
                      <td style={tdStyle}>{result?.name || "-"}</td>
                      <td style={tdStyle}>{result?.address || "-"}</td>
                      <td style={tdStyle}>{result?.source || "-"}</td>
                      <td style={tdStyle}>{result?.checkedAt || "-"}</td>
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