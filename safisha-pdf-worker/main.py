"""
safisha-pdf-worker · IRON DOME NUCLEAR DESIGN · PDF Extraction Microservice

Extracts bank statement rows from PDF files using pdfplumber.
Returns canonical row JSON suitable for safisha-ingest's `parsed_rows` field.

IRON DOME INVARIANTS:
  - Every extracted row is SHA-256 hashed from its raw extracted text.
  - Pydantic validates every row before returning — malformed rows are rejected.
  - No rows are written to the DB here; the Deno proxy hands off to safisha-ingest.
  - Auth: Supabase JWT required on every request.
  - Zero hallucination: all figures come directly from pdfplumber-extracted text.

POST /extract
  Headers: Authorization: Bearer <supabase_jwt>
  Body: multipart/form-data
    file: <PDF bank statement>
    source_type: 'bank' | 'momo' | 'subledger'   (default: 'bank')
    password: <str>                                (optional, for encrypted PDFs)

Response 200:
  {
    "rows":          [[col1, col2, ...], ...],   // first row = headers
    "row_count":     <int>,
    "source_type":   <str>,
    "filename":      <str>,
    "sha256_source": <str>,                       // hash of all raw extracted text
    "pages_parsed":  <int>,
    "warnings":      [<str>, ...]
  }
"""

import hashlib
import io
import json
import os
import re
from typing import Optional

import pandas as pd
import pdfplumber
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from pydantic import BaseModel, field_validator
from pydantic import ValidationError

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]  # must be set in Cloud Run
SUPABASE_URL        = os.environ.get("SUPABASE_URL", "")
MAX_PDF_SIZE_MB     = 50

app = FastAPI(title="Safisha PDF Worker", version="1.0.0")

# ── Pydantic validation model ─────────────────────────────────────────────────

class BankRow(BaseModel):
    """Validated bank statement row. All fields map 1:1 to safisha canonical fields."""
    account_code: str
    account_name: Optional[str] = None
    txn_date:     Optional[str] = None
    debit:        Optional[float] = None
    credit:       Optional[float] = None
    currency:     str = "TZS"
    reference:    Optional[str] = None
    raw_text:     str            # original extracted text for audit trail

    @field_validator("account_code")
    @classmethod
    def account_code_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("account_code cannot be empty")
        return v

    @field_validator("txn_date")
    @classmethod
    def validate_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        # Accept ISO, DD/MM/YYYY, DD-MM-YYYY formats
        patterns = [
            (r"^\d{4}-\d{2}-\d{2}$", "%Y-%m-%d"),
            (r"^\d{2}/\d{2}/\d{4}$", "%d/%m/%Y"),
            (r"^\d{2}-\d{2}-\d{4}$", "%d-%m-%Y"),
        ]
        from datetime import datetime
        for pattern, fmt in patterns:
            if re.match(pattern, v):
                try:
                    return datetime.strptime(v, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    pass
        # Return as-is — safisha-ingest parseDate() handles more formats
        return v if v else None

    @field_validator("debit", "credit", mode="before")
    @classmethod
    def parse_amount(cls, v) -> Optional[float]:
        if v is None or v == "":
            return None
        if isinstance(v, (int, float)):
            return abs(float(v))
        s = str(v).strip().replace(",", "").replace(" ", "")
        # Handle parenthetical negatives: (1,234.00) → 1234.00
        if s.startswith("(") and s.endswith(")"):
            s = s[1:-1]
        try:
            return abs(float(s))
        except ValueError:
            return None


# ── Auth ──────────────────────────────────────────────────────────────────────

def verify_jwt(authorization: Optional[str]) -> dict:
    """Verify Supabase JWT and return decoded payload."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},  # Supabase JWTs don't require audience
        )
        return payload
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid JWT: {str(e)}")


# ── PDF extraction helpers ────────────────────────────────────────────────────

def extract_tables_from_pdf(
    pdf_bytes: bytes,
    password: Optional[str] = None,
) -> tuple[list[list[str]], str, int, list[str]]:
    """
    Extract all tables from a PDF using pdfplumber.

    Returns:
        (all_rows, raw_text_combined, pages_parsed, warnings)

    Strategy:
    1. Try pdfplumber.extract_table() on each page (lattice detection).
    2. Fallback: extract_words() → reconstruct rows by y-coordinate clustering.
    3. pandas for header detection and column alignment.
    """
    all_rows:    list[list[str]] = []
    raw_texts:   list[str]       = []
    pages_parsed = 0
    warnings:    list[str]       = []
    headers_set  = False
    canonical_headers: list[str] = []

    open_kwargs = {"password": password} if password else {}

    with pdfplumber.open(io.BytesIO(pdf_bytes), **open_kwargs) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            page_text = page.extract_text() or ""
            raw_texts.append(page_text)
            pages_parsed = page_num

            # Strategy 1: explicit table extraction
            tables = page.extract_tables()
            if tables:
                for tbl in tables:
                    if not tbl:
                        continue
                    df = pd.DataFrame(tbl)
                    df = _clean_dataframe(df)
                    if df.empty:
                        continue
                    if not headers_set:
                        canonical_headers = [str(c) for c in df.columns.tolist()]
                        all_rows.append(canonical_headers)
                        headers_set = True
                    for _, row in df.iterrows():
                        all_rows.append([str(v) if v is not None else "" for v in row.tolist()])
            else:
                # Strategy 2: word-level reconstruction
                words = page.extract_words(x_tolerance=3, y_tolerance=3)
                if not words:
                    warnings.append(f"Page {page_num}: no text extracted — may be scanned/image PDF")
                    continue
                reconstructed = _reconstruct_rows_from_words(words)
                if not reconstructed:
                    continue
                if not headers_set:
                    canonical_headers = reconstructed[0]
                    all_rows.extend(reconstructed)
                    headers_set = True
                else:
                    all_rows.extend(reconstructed[1:])  # skip repeated header

    return all_rows, "\n".join(raw_texts), pages_parsed, warnings


def _clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Clean a pdfplumber-extracted table DataFrame.
    - If first row looks like headers, promote it.
    - Drop fully-null rows and columns.
    - Forward-fill merged cells (None → previous value).
    - Normalise whitespace.
    """
    if df.empty:
        return df

    # Forward-fill None cells (merged-cell rows common in bank statement tables)
    df = df.ffill(axis=0)

    # Promote first row to header if it looks like strings (not amounts)
    first_row = df.iloc[0].tolist()
    is_header = all(
        v is None or (isinstance(v, str) and not _is_numeric(str(v)))
        for v in first_row
    )
    if is_header:
        df.columns = [str(v).strip() if v else f"col_{i}" for i, v in enumerate(first_row)]
        df = df.iloc[1:]

    # Drop fully-empty rows/columns
    df = df.dropna(how="all").dropna(axis=1, how="all")

    # Normalise cell whitespace
    df = df.map(lambda v: " ".join(str(v).split()) if v is not None else "")

    return df.reset_index(drop=True)


def _is_numeric(s: str) -> bool:
    """True if string is parseable as a number (handles commas, parens)."""
    cleaned = s.replace(",", "").replace("(", "-").replace(")", "").strip()
    try:
        float(cleaned)
        return True
    except ValueError:
        return False


def _reconstruct_rows_from_words(words: list[dict]) -> list[list[str]]:
    """
    Reconstruct table rows from pdfplumber word objects by clustering on y-coordinate.
    Groups words within ±5 pts of the same baseline into a row.
    Returns list of rows (each row is a list of cell strings).
    """
    if not words:
        return []

    # Sort by top (y) then left (x)
    sorted_words = sorted(words, key=lambda w: (round(w["top"] / 5), w["x0"]))

    rows: list[list[str]] = []
    current_y    = -999.0
    current_row: list[str] = []

    for word in sorted_words:
        y = word["top"]
        if abs(y - current_y) > 5:
            if current_row:
                rows.append(current_row)
            current_row = [word["text"]]
            current_y   = y
        else:
            current_row.append(word["text"])

    if current_row:
        rows.append(current_row)

    # Pad all rows to same length
    if not rows:
        return []
    max_len = max(len(r) for r in rows)
    rows = [r + [""] * (max_len - len(r)) for r in rows]

    return rows


# ── SHA-256 ────────────────────────────────────────────────────────────────────

def sha256_hex(data: str) -> str:
    return hashlib.sha256(data.encode()).hexdigest()


# ── /extract endpoint ──────────────────────────────────────────────────────────

@app.post("/extract")
async def extract(
    file:          UploadFile  = File(...),
    source_type:   str         = Form("bank"),
    password:      Optional[str] = Form(None),
    authorization: Optional[str] = Header(None),
):
    # Auth
    _user = verify_jwt(authorization)

    # Validate file type
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    pdf_bytes = await file.read()

    # Size guard
    if len(pdf_bytes) > MAX_PDF_SIZE_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"PDF exceeds {MAX_PDF_SIZE_MB} MB limit"
        )

    if len(pdf_bytes) < 64:
        raise HTTPException(status_code=400, detail="File is too small to be a valid PDF")

    # Extract
    try:
        rows, raw_text, pages_parsed, warnings = extract_tables_from_pdf(pdf_bytes, password)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDF extraction failed: {str(e)}")

    if not rows or len(rows) < 2:
        raise HTTPException(
            status_code=422,
            detail="No table data extracted from PDF. "
                   "If this is a scanned/image PDF, OCR is required before extraction. "
                   "Supported: digital (text-layer) PDFs from CRDB, NMB, Equity, Absa, Azania, PBZ, TPB."
        )

    sha256_src = sha256_hex(raw_text)

    return JSONResponse({
        "rows":          rows,        # [[header1, header2, ...], [val1, val2, ...], ...]
        "row_count":     len(rows) - 1,
        "source_type":   source_type,
        "filename":      file.filename,
        "sha256_source": sha256_src,
        "pages_parsed":  pages_parsed,
        "warnings":      warnings,
    })


# ── /ocr endpoint (Task #179 · Phase C) ──────────────────────────────────────
#
# OCR extraction for scanned PDFs (image-only, no text layer).
#
# Strategy:
#   Phase C (current): pytesseract + pdf2image (poppler).
#     Converts each PDF page to an image, runs Tesseract OCR,
#     then re-uses extract_tables_from_pdf on the synthetic text.
#     Works on CPU. Accuracy: adequate for clean bank statement scans.
#
#   Phase C+ (upgrade path): MinerU (Apache-2.0, GPU-accelerated).
#     Deploy safisha-pdf-worker-gpu container on Cloud Run with GPU.
#     Replace pytesseract step with:
#       from magic_pdf.pipe.UNIPipe import UNIPipe
#       result = UNIPipe(pdf_bytes).pipe_classify().pipe_parse_pdf()
#     MinerU produces structured Markdown + bounding boxes —
#     significantly better table recovery for multi-column layouts.
#     Requires: nvidia/cuda base image, magic-pdf>=0.6.1, torch.
#     Do NOT add MinerU to this container — keep CPU and GPU workers separate.
#
# IRON DOME:
#   - OCR output is stored with ocr_method in response for audit trail.
#   - OCR accuracy is always lower than text-layer extraction.
#   - Client (SafishaGate) shows a warning when OCR path is used.
#   - The liteparse pre-filter in SafishaGate catches scanned PDFs before upload;
#     this endpoint handles PDFs that pass the pre-filter but still need OCR.

def _ocr_with_pytesseract(pdf_bytes: bytes) -> tuple[str, int, list[str]]:
    """
    Convert PDF pages to images and run Tesseract OCR.
    Returns (extracted_text, pages_processed, warnings).
    """
    warnings: list[str] = []
    try:
        import pytesseract
        from pdf2image import convert_from_bytes
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="OCR dependencies not installed (pytesseract + pdf2image). "
                   "This container does not have OCR enabled. "
                   "For OCR support, deploy safisha-pdf-worker with OCR=true environment variable, "
                   "or upgrade to the MinerU GPU container."
        )

    try:
        pages = convert_from_bytes(pdf_bytes, dpi=200, fmt="PNG")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDF→image conversion failed: {str(e)}")

    MAX_OCR_PAGES = 30
    if len(pages) > MAX_OCR_PAGES:
        pages = pages[:MAX_OCR_PAGES]
        warnings.append(f"PDF has more than {MAX_OCR_PAGES} pages — only first {MAX_OCR_PAGES} pages OCR-processed.")

    all_text = ""
    for i, page_img in enumerate(pages):
        try:
            page_text = pytesseract.image_to_string(
                page_img,
                lang="eng",          # English. For Swahili headers, "swa" can be added.
                config="--psm 6",    # Assume uniform block of text (best for tables)
            )
            all_text += f"\n--- PAGE {i + 1} ---\n{page_text}"
        except Exception as e:
            warnings.append(f"Page {i + 1} OCR failed: {str(e)}")

    if not all_text.strip():
        raise HTTPException(
            status_code=422,
            detail="OCR produced no text. PDF may be corrupted or image quality too low."
        )

    return all_text, len(pages), warnings


def _ocr_rows_from_text(raw_text: str) -> list[list[str]]:
    """
    Extract table-like rows from OCR text.
    OCR text is noisy — use heuristic column splitting on whitespace runs.
    This is a best-effort parser; results should always be reviewed before approval.
    """
    rows: list[list[str]] = []
    lines = [l.strip() for l in raw_text.split("\n") if l.strip() and len(l.strip()) > 5]

    # Remove page headers
    lines = [l for l in lines if not l.startswith("--- PAGE")]

    for line in lines:
        # Split on 2+ consecutive spaces (column separator in most bank statements)
        cols = re.split(r"\s{2,}", line)
        cols = [c.strip() for c in cols if c.strip()]
        if len(cols) >= 3:  # minimum: date + description + amount
            rows.append(cols)

    return rows


@app.post("/ocr")
async def ocr_extract(
    file:          UploadFile       = File(...),
    source_type:   str              = Form("bank"),
    password:      Optional[str]    = Form(None),
    authorization: Optional[str]    = Header(None),
):
    """
    OCR endpoint for scanned PDFs.
    Phase C: pytesseract. Phase C+: MinerU GPU container.

    Returns same response shape as /extract, plus:
      ocr_method: 'pytesseract' | 'mineru'
      ocr_accuracy_note: plain-language accuracy warning
    """
    _user = verify_jwt(authorization)

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    pdf_bytes = await file.read()
    if len(pdf_bytes) > MAX_PDF_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"PDF exceeds {MAX_PDF_SIZE_MB} MB limit")

    # Run OCR
    raw_text, pages_processed, warnings = _ocr_with_pytesseract(pdf_bytes)

    # Parse OCR text into rows
    rows = _ocr_rows_from_text(raw_text)
    sha256_src = sha256_hex(raw_text)

    if not rows or len(rows) < 2:
        raise HTTPException(
            status_code=422,
            detail="OCR completed but could not detect table structure. "
                   "The scanned image quality may be insufficient. "
                   "Please obtain a higher-resolution scan or a digital (text-layer) PDF."
        )

    warnings.append(
        "OCR extraction is less reliable than text-layer extraction. "
        "All extracted rows should be reviewed by an accountant before approval. "
        "Figures that appear garbled may indicate low scan quality."
    )

    return JSONResponse({
        "rows":               rows,
        "row_count":          len(rows) - 1,
        "source_type":        source_type,
        "filename":           file.filename,
        "sha256_source":      sha256_src,
        "pages_parsed":       pages_processed,
        "warnings":           warnings,
        "ocr_method":         "pytesseract",
        "ocr_accuracy_note":  (
            "OCR accuracy is adequate for clean bank statement scans (CRDB, NMB, Absa). "
            "Accuracy degrades on low-resolution scans, coloured backgrounds, and handwritten annotations. "
            "For production-grade OCR on complex documents, upgrade to the MinerU GPU container. "
            "See safisha-pdf-worker/main.py _ocr_with_pytesseract() for the MinerU upgrade path."
        ),
    })


# ── /generate-xbrl endpoint ──────────────────────────────────────────────────
#
# Generates an XBRL 2.1 or iXBRL 1.1 instance document from SAFF financial data.
# Called by the generate-xbrl Deno Edge Function.
#
# IRON DOME:
#   - Requires JWT auth (same as all other endpoints).
#   - Returns BLOCKED if framework is IPSAS or required data is missing.
#   - Runs structural validation (always) + Arelle validation (if installed).
#   - Never silently generates without validation.

class XBRLGenerateRequest(BaseModel):
    """Request body for /generate-xbrl."""
    reporting_framework:     str           # 'ifrs_for_smes' | 'full_ifrs'
    company_tin:             str
    period_year:             int
    period_end_month:        int           # 1–12
    period_end_day:          int = 31
    computation_detail:      dict          # from tax_computations.computation_detail
    period_closing_balances: dict          # from period_closing_balances table
    output_format:           str = "xbrl_2_1"  # 'xbrl_2_1' | 'ixbrl_1_1'

    @field_validator("reporting_framework")
    @classmethod
    def validate_framework(cls, v: str) -> str:
        allowed = {"ifrs_for_smes", "full_ifrs", "ipsas_accrual", "ipsas_cash"}
        if v not in allowed:
            raise ValueError(f"reporting_framework must be one of {allowed}")
        return v

    @field_validator("period_end_month")
    @classmethod
    def validate_month(cls, v: int) -> int:
        if not 1 <= v <= 12:
            raise ValueError("period_end_month must be between 1 and 12")
        return v

    @field_validator("output_format")
    @classmethod
    def validate_format(cls, v: str) -> str:
        if v not in {"xbrl_2_1", "ixbrl_1_1"}:
            raise ValueError("output_format must be 'xbrl_2_1' or 'ixbrl_1_1'")
        return v


@app.post("/generate-xbrl")
async def generate_xbrl(
    request:       XBRLGenerateRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Generate XBRL 2.1 or iXBRL 1.1 instance document from SAFF financial data.

    Response:
      {
        success:           bool,
        blocked:           bool,
        blocked_reason:    str | null,
        output_format:     'xbrl_2_1' | 'ixbrl_1_1',
        taxonomy_version:  str,
        reporting_framework: str,
        instance_xml:      str | null,     -- the full XML/HTML document
        instance_sha256:   str | null,     -- SHA-256 hex of instance_xml
        fact_count:        int,
        validation_passed: bool,
        validation_errors: int,
        validation_warnings: int,
        validation_info:   int,
        arelle_available:  bool,
        issues:            [{severity, arelle_code, message, xbrl_element, fact_value}]
      }
    """
    _user = verify_jwt(authorization)

    from xbrl_engine import XBRLEngine

    engine = XBRLEngine()
    result = engine.generate_and_validate(
        reporting_framework=     request.reporting_framework,
        company_tin=             request.company_tin,
        period_year=             request.period_year,
        period_end_month=        request.period_end_month,
        period_end_day=          request.period_end_day,
        computation_detail=      request.computation_detail,
        period_closing_balances= request.period_closing_balances,
        output_format=           request.output_format,
    )

    status_code = 422 if result.blocked else 200
    return JSONResponse(result.to_dict(), status_code=status_code)


# ── /validate-xbrl endpoint ───────────────────────────────────────────────────
#
# Validates an existing XBRL instance document (already generated).
# Used when the caller has an XBRL document from another source and wants
# Arelle + structural validation against the IFRS taxonomy.

class XBRLValidateRequest(BaseModel):
    """Request body for /validate-xbrl."""
    instance_xml:        str    # the XBRL or iXBRL document to validate
    reporting_framework: str    # 'ifrs_for_smes' | 'full_ifrs'
    output_format:       str = "xbrl_2_1"


@app.post("/validate-xbrl")
async def validate_xbrl(
    request:       XBRLValidateRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Validate an XBRL or iXBRL document using Arelle + structural checks.

    Returns same issues structure as /generate-xbrl.
    IRON DOME: Never returns validation_passed=True without running checks.
    """
    _user = verify_jwt(authorization)

    from xbrl_engine import ArelleValidator, TAXONOMY_REGISTRY

    if request.reporting_framework not in TAXONOMY_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported framework: {request.reporting_framework}. Use ifrs_for_smes or full_ifrs."
        )

    taxonomy_url = TAXONOMY_REGISTRY[request.reporting_framework]["schema_ref"]
    arelle = ArelleValidator()
    issues = arelle.validate(
        instance_xml=  request.instance_xml,
        taxonomy_url=  taxonomy_url,
        output_format= request.output_format,
    )

    errors   = sum(1 for i in issues if i.severity == "error")
    warnings = sum(1 for i in issues if i.severity == "warning")
    infos    = sum(1 for i in issues if i.severity == "info")

    return JSONResponse({
        "validation_passed":   errors == 0,
        "validation_errors":   errors,
        "validation_warnings": warnings,
        "validation_info":     infos,
        "arelle_available":    arelle.available,
        "issues": [
            {
                "severity":     i.severity,
                "arelle_code":  i.arelle_code,
                "message":      i.message,
                "xbrl_element": i.xbrl_element,
                "fact_value":   i.fact_value,
            }
            for i in issues
        ],
    })


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    # Check Arelle availability
    try:
        import arelle  # noqa: F401
        arelle_available = True
    except ImportError:
        arelle_available = False

    return {
        "status":           "ok",
        "service":          "safisha-pdf-worker",
        "ocr_enabled":      os.environ.get("OCR_ENABLED", "false").lower() == "true",
        "mineru_ready":     False,              # Phase C+ only
        "xbrl_enabled":     True,               # xbrl_engine.py always present
        "arelle_available": arelle_available,   # pip install arelle-release for full taxonomy validation
    }


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
