import { useState, useEffect, useCallback, useRef } from "react";
import { NotesMacro, Suggestion, BreachNotification } from "@/api/entities";

const PROXY_URL = "https://friday-e54fce34.base44.app/functions/awsProxy";

async function awsCall(method, path, body) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path, payload: body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed: " + res.status);
  }
  return res.json();
}
const awsGet = (path) => awsCall("GET", path);
const awsPost = (path, body) => awsCall("POST", path, body);
const awsPut = (path, body) => awsCall("PUT", path, body);
const awsDelete = (path) => awsCall("DELETE", path);

// ─── Styles ──────────────────────────────────────────────────────────────────
const SIDEBAR_BG = "#1a2e4a";
const ACCENT = "#2563eb";
const ACCENT_LIGHT = "#eff6ff";
const SUCCESS = "#16a34a";
const WARNING = "#d97706";
const DANGER = "#dc2626";
const GRAY_50 = "#f9fafb";
const GRAY_100 = "#f3f4f6";
const GRAY_200 = "#e5e7eb";
const GRAY_400 = "#9ca3af";
const GRAY_500 = "#6b7280";
const GRAY_600 = "#4b5563";
const GRAY_700 = "#374151";
const GRAY_900 = "#111827";
const WHITE = "#ffffff";

const s = {
  page: { padding: "28px 32px", maxWidth: 1100, margin: "0 auto" },
  pageHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  h1: { margin: 0, fontSize: 22, fontWeight: 700, color: GRAY_900 },
  sub: { margin: "4px 0 0", fontSize: 13.5, color: GRAY_500 },
  card: { background: WHITE, borderRadius: 10, border: `1px solid ${GRAY_200}`, padding: "18px 20px" },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: GRAY_600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 5 },
  input: { width: "100%", padding: "8px 11px", border: `1px solid ${GRAY_200}`, borderRadius: 7, fontSize: 13.5, boxSizing: "border-box", outline: "none", color: GRAY_900 },
  select: { width: "100%", padding: "8px 11px", border: `1px solid ${GRAY_200}`, borderRadius: 7, fontSize: 13.5, boxSizing: "border-box", outline: "none", color: GRAY_900, background: WHITE },
  textarea: { width: "100%", padding: "8px 11px", border: `1px solid ${GRAY_200}`, borderRadius: 7, fontSize: 13.5, boxSizing: "border-box", outline: "none", color: GRAY_900, resize: "vertical" },
};

// ─── Shared UI ────────────────────────────────────────────────────────────────
function Btn({ children, onClick, variant = "primary", size = "md", disabled, style = {} }) {
  const v = {
    primary: { background: ACCENT, color: WHITE, border: "none" },
    secondary: { background: WHITE, color: GRAY_700, border: `1px solid ${GRAY_200}` },
    danger: { background: DANGER, color: WHITE, border: "none" },
    success: { background: SUCCESS, color: WHITE, border: "none" },
    ghost: { background: "transparent", color: GRAY_500, border: "none" },
    warning: { background: WARNING, color: WHITE, border: "none" },
  };
  const sz = { sm: { padding: "5px 10px", fontSize: 12 }, md: { padding: "7px 14px", fontSize: 13.5 }, lg: { padding: "10px 20px", fontSize: 15 } };
  return <button onClick={onClick} disabled={disabled} style={{ borderRadius: 7, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 500, opacity: disabled ? 0.5 : 1, ...v[variant], ...sz[size], ...style }}>{children}</button>;
}

function Badge({ label, color = GRAY_500, bg = GRAY_100 }) {
  return <span style={{ display: "inline-flex", padding: "2px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, color, background: bg, whiteSpace: "nowrap" }}>{label}</span>;
}

function Tag({ label }) {
  return <span style={{ display: "inline-flex", padding: "1px 7px", borderRadius: 4, fontSize: 11, color: GRAY_600, background: GRAY_100, border: `1px solid ${GRAY_200}` }}>{label}</span>;
}

function Pill({ children, active, onClick }) {
  return <button onClick={onClick} style={{ padding: "5px 14px", borderRadius: 999, fontSize: 13, border: "none", cursor: "pointer", fontWeight: active ? 600 : 400, background: active ? ACCENT : GRAY_100, color: active ? WHITE : GRAY_600 }}>{children}</button>;
}

function Modal({ title, subtitle, onClose, children, width = 580 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: WHITE, borderRadius: 12, width, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: GRAY_900 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: GRAY_500, marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: GRAY_100, border: "none", width: 28, height: 28, borderRadius: 6, cursor: "pointer", fontSize: 14, color: GRAY_500 }}>✕</button>
        </div>
        <div style={{ padding: "20px 24px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function FormField({ label, children, required }) {
  return <div style={{ marginBottom: 14 }}><label style={{ ...s.label }}>{label}{required && <span style={{ color: DANGER }}> *</span>}</label>{children}</div>;
}

function Spinner({ text = "Loading..." }) {
  return <div style={{ textAlign: "center", padding: 60, color: GRAY_400, fontSize: 14 }}>{text}</div>;
}

function EmptyState({ icon, title, sub, action }) {
  return (
    <div style={{ textAlign: "center", padding: "56px 24px", color: GRAY_400 }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: GRAY_600, marginBottom: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: GRAY_400, marginBottom: 16 }}>{sub}</div>}
      {action}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    completed: { label: "Completed", color: SUCCESS, bg: "#dcfce7" },
    processed: { label: "Processed", color: SUCCESS, bg: "#dcfce7" },
    processing: { label: "Processing", color: WARNING, bg: "#fef3c7" },
    uploaded: { label: "Uploaded", color: GRAY_500, bg: GRAY_100 },
    failed: { label: "Failed", color: DANGER, bg: "#fee2e2" },
    pending: { label: "Pending", color: WARNING, bg: "#fef3c7" },
    open: { label: "Open", color: DANGER, bg: "#fee2e2" },
    resolved: { label: "Resolved", color: SUCCESS, bg: "#dcfce7" },
  };
  const v = map[status] || map.uploaded;
  return <Badge label={v.label} color={v.color} bg={v.bg} />;
}

function CategoryBadge({ category, subcategory }) {
  const catColors = {
    medical: { color: "#1d4ed8", bg: "#dbeafe" },
    legal: { color: "#7c3aed", bg: "#ede9fe" },
    imaging: { color: "#0891b2", bg: "#cffafe" },
    other: { color: GRAY_500, bg: GRAY_100 },
  };
  const c = catColors[category?.toLowerCase()] || catColors.other;
  return (
    <span>
      <Badge label={category || "other"} color={c.color} bg={c.bg} />
      {subcategory && <span style={{ fontSize: 11, color: GRAY_400, marginLeft: 5 }}>{subcategory.replace(/_/g, " ")}</span>}
    </span>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({ page, onNav, counts }) {
  const items = [
    { id: "dashboard", icon: "📊", label: "Dashboard" },
    { id: "documents", icon: "📁", label: "Documents", count: counts.documents },
    { id: "summaries", icon: "📋", label: "Medical Summaries", count: counts.summaries },
    { id: "patients", icon: "👥", label: "Patients", count: counts.patients },
    { id: "macros", icon: "📝", label: "Notes Macros" },
    { id: "admin", icon: "⚙️", label: "Admin" },
  ];
  return (
    <div style={{ width: 232, background: SIDEBAR_BG, display: "flex", flexDirection: "column", minHeight: "100vh", flexShrink: 0 }}>
      <div style={{ padding: "24px 18px 18px" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: WHITE, letterSpacing: "-0.3px" }}>ChartReview Pro</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>HIPAA Compliant · AWS Backend</div>
      </div>
      <nav style={{ flex: 1, padding: "2px 10px" }}>
        {items.map(item => {
          const active = page === item.id;
          return (
            <button key={item.id} onClick={() => onNav(item.id)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              width: "100%", padding: "9px 10px", marginBottom: 2,
              border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13.5,
              fontWeight: active ? 600 : 400,
              background: active ? "rgba(255,255,255,0.13)" : "transparent",
              color: active ? WHITE : "rgba(255,255,255,0.6)",
              borderLeft: active ? `3px solid ${ACCENT}` : "3px solid transparent",
              paddingLeft: active ? 7 : 10,
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 15 }}>{item.icon}</span> {item.label}
              </span>
              {item.count > 0 && <span style={{ fontSize: 11, background: active ? ACCENT : "rgba(255,255,255,0.15)", color: WHITE, padding: "1px 6px", borderRadius: 999 }}>{item.count}</span>}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: "14px 18px", borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
        🔒 PHI on AWS · BAA Active
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ onNav, patients, documents, summaries }) {
  const processed = documents.filter(d => ["completed", "processed"].includes(d.status)).length;
  const withDupes = documents.filter(d => d.has_duplicate_pages).length;

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.h1}>Dashboard</h1>
          <p style={s.sub}>Overview of your chart review workspace</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 28 }}>
        {[
          { icon: "📁", label: "Total Documents", value: documents.length, color: ACCENT, page: "documents" },
          { icon: "✅", label: "Processed", value: processed, color: SUCCESS, page: "documents" },
          { icon: "⚠️", label: "Has Duplicates", value: withDupes, color: WARNING, page: "documents" },
          { icon: "📋", label: "Summaries", value: summaries.length, color: "#7c3aed", page: "summaries" },
        ].map(sc => (
          <div key={sc.label} onClick={() => onNav(sc.page)} style={{ ...s.card, cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: sc.color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{sc.icon}</div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 800, color: GRAY_900 }}>{sc.value}</div>
              <div style={{ fontSize: 12, color: GRAY_500 }}>{sc.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20 }}>
        <div style={s.card}>
          <div style={{ fontWeight: 700, fontSize: 14, color: GRAY_900, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
            Recent Documents <span onClick={() => onNav("documents")} style={{ fontSize: 12, fontWeight: 400, color: ACCENT, cursor: "pointer" }}>View all →</span>
          </div>
          {documents.length === 0 ? <div style={{ color: GRAY_400, fontSize: 13, textAlign: "center", padding: 20 }}>No documents yet</div> :
            documents.slice(0, 6).map(d => (
              <div key={d.aws_document_id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${GRAY_100}` }}>
                <span style={{ fontSize: 18 }}>📄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: GRAY_900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || d.file_name}</div>
                  <div style={{ fontSize: 11.5, color: GRAY_400 }}>{d.patient_name || "—"} · {d.category || "—"}</div>
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))}
        </div>

        <div style={s.card}>
          <div style={{ fontWeight: 700, fontSize: 14, color: GRAY_900, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
            Patients <span onClick={() => onNav("patients")} style={{ fontSize: 12, fontWeight: 400, color: ACCENT, cursor: "pointer" }}>View all →</span>
          </div>
          {patients.length === 0 ? <div style={{ color: GRAY_400, fontSize: 13, textAlign: "center", padding: 20 }}>No patients yet</div> :
            patients.slice(0, 8).map(p => (
              <div key={p.aws_patient_id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${GRAY_100}` }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: ACCENT_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: ACCENT }}>
                  {(p.patient_name || "?")[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: GRAY_900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.patient_name}</div>
                  {p.case_number && <div style={{ fontSize: 11, color: GRAY_400 }}>Case: {p.case_number}</div>}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────
const DOC_CATEGORIES = ["Medical Records", "Imaging", "Lab Results", "Operative Notes", "Discharge Summary", "Consultation", "Physical Therapy", "Mental Health", "Legal", "Other"];

function Documents({ patients, documents, onRefresh }) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showUpload, setShowUpload] = useState(false);
  const [viewDoc, setViewDoc] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState({});
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ patient_name: "", title: "", category: "Medical Records", case_number: "" });

  const filtered = documents.filter(d => {
    if (search && !`${d.patient_name || ""} ${d.title || ""} ${d.file_name || ""} ${d.case_number || ""}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (catFilter !== "all" && (d.category || "other").toLowerCase() !== catFilter) return false;
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    return true;
  });

  const uploadDoc = async () => {
    if (!file) return alert("Please select a file.");
    if (!form.patient_name.trim()) return alert("Patient name is required.");
    setUploading(true);
    try {
      const pRes = await awsPost("/patients", { patient_name: form.patient_name.trim(), case_number: form.case_number.trim() || undefined });
      const awsPatientId = pRes?.aws_patient_id;
      const uploadData = await awsPost("/documents/upload-url", {
        aws_patient_id: awsPatientId,
        patient_name: form.patient_name.trim(),
        file_name: file.name,
        content_type: file.type || "application/octet-stream",
        title: form.title || file.name,
        category: form.category,
        case_number: form.case_number || undefined,
      });
      if (!uploadData.upload_url) throw new Error("No upload URL returned");
      const s3 = await fetch(uploadData.upload_url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!s3.ok) throw new Error("S3 upload failed: " + s3.status);
      await awsPost(`/documents/${uploadData.aws_document_id}/process`, {}).catch(() => {});
      alert("✅ Document uploaded and queued for AI processing.");
      setShowUpload(false); setFile(null); setForm({ patient_name: "", title: "", category: "Medical Records", case_number: "" });
      onRefresh();
    } catch (e) { alert("Upload failed: " + e.message); }
    setUploading(false);
  };

  const processDoc = async (doc) => {
    setProcessing(p => ({ ...p, [doc.aws_document_id]: true }));
    try {
      const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      const preview = res.summary ? `\n\nSummary preview:\n${res.summary.substring(0, 500)}…` : "";
      alert("✅ Processing complete!" + preview);
      onRefresh();
    } catch (e) { alert("Processing failed: " + e.message); }
    setProcessing(p => ({ ...p, [doc.aws_document_id]: false }));
  };

  const deleteDoc = async (doc) => {
    if (!confirm(`Delete "${doc.title || doc.file_name}"? This cannot be undone.`)) return;
    try { await awsDelete(`/documents/${doc.aws_document_id}`); onRefresh(); }
    catch (e) { alert("Delete failed: " + e.message); }
  };

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.h1}>Documents</h1>
          <p style={s.sub}>{documents.length} document{documents.length !== 1 ? "s" : ""} · {documents.filter(d => d.has_duplicate_pages).length} with duplicate pages</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
          <Btn onClick={() => setShowUpload(true)}>+ Upload Document</Btn>
        </div>
      </div>

      {/* Filters */}
      <div style={{ ...s.card, marginBottom: 16, padding: "14px 16px" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search documents, patients, cases…"
            style={{ ...s.input, flex: 1, minWidth: 200 }} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ ...s.select, width: "auto", minWidth: 140 }}>
            <option value="all">All Categories</option>
            <option value="medical">Medical</option>
            <option value="legal">Legal</option>
            <option value="imaging">Imaging</option>
            <option value="other">Other</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...s.select, width: "auto", minWidth: 130 }}>
            <option value="all">All Status</option>
            <option value="uploaded">Uploaded</option>
            <option value="processing">Processing</option>
            <option value="processed">Processed</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
          {(search || catFilter !== "all" || statusFilter !== "all") && <Btn onClick={() => { setSearch(""); setCatFilter("all"); setStatusFilter("all"); }} variant="ghost" size="sm">Clear</Btn>}
        </div>
      </div>

      {/* Document List */}
      {documents.length === 0 ? (
        <EmptyState icon="📁" title="No documents yet" sub="Upload a medical record to get started" action={<Btn onClick={() => setShowUpload(true)}>Upload Document</Btn>} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍" title="No documents match your filters" sub="Try adjusting your search or filters" />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filtered.map(d => (
            <div key={d.aws_document_id} style={{ ...s.card, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: 9, background: ACCENT_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 }}>
                {d.file_type?.includes("pdf") ? "📄" : d.file_type?.includes("image") ? "🖼️" : "📄"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: GRAY_900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || d.file_name}</span>
                  {d.has_duplicate_pages && <Badge label="⚠ Duplicate Pages" color={WARNING} bg="#fef3c7" />}
                  {d.is_duplicate && <Badge label="Duplicate" color={DANGER} bg="#fee2e2" />}
                </div>
                <div style={{ fontSize: 12, color: GRAY_500, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {d.patient_name && <span>👤 {d.patient_name}</span>}
                  {d.case_number && <span>📁 {d.case_number}</span>}
                  {d.provider_name && <span>🏥 {d.provider_name}</span>}
                  {d.page_count && <span>📃 {d.page_count} pages</span>}
                  {d.document_date && <span>📅 {d.document_date}</span>}
                  <CategoryBadge category={d.category} subcategory={d.subcategory} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                <StatusBadge status={d.status} />
                {!["completed", "processed"].includes(d.status) && (
                  <Btn onClick={() => processDoc(d)} variant="secondary" size="sm" disabled={processing[d.aws_document_id]}>
                    {processing[d.aws_document_id] ? "…" : "⚡ Process"}
                  </Btn>
                )}
                <Btn onClick={() => setViewDoc(d)} variant="secondary" size="sm">View</Btn>
                <Btn onClick={() => deleteDoc(d)} variant="ghost" size="sm" style={{ color: DANGER }}>✕</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <Modal title="Upload Document" subtitle="Document will be stored on AWS and processed by AI" onClose={() => { setShowUpload(false); setFile(null); }}>
          <FormField label="Patient Name" required>
            <input style={s.input} value={form.patient_name} onChange={e => setForm(f => ({ ...f, patient_name: e.target.value }))} placeholder="e.g. Jane Smith" />
          </FormField>
          <FormField label="Case Number">
            <input style={s.input} value={form.case_number} onChange={e => setForm(f => ({ ...f, case_number: e.target.value }))} placeholder="e.g. 4A2505HTQH00001" />
          </FormField>
          <FormField label="Document Title">
            <input style={s.input} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Leave blank to use filename" />
          </FormField>
          <FormField label="Category">
            <select style={s.select} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
              {DOC_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="File" required>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.tiff" onChange={e => setFile(e.target.files[0])} style={{ fontSize: 13.5 }} />
            {file && <div style={{ marginTop: 5, fontSize: 12, color: GRAY_500 }}>📎 {file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</div>}
          </FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => { setShowUpload(false); setFile(null); }} variant="secondary">Cancel</Btn>
            <Btn onClick={uploadDoc} disabled={uploading}>{uploading ? "Uploading…" : "Upload & Process"}</Btn>
          </div>
        </Modal>
      )}

      {/* View Document Modal */}
      {viewDoc && (
        <Modal title={viewDoc.title || viewDoc.file_name} subtitle={`Patient: ${viewDoc.patient_name || "—"} · Case: ${viewDoc.case_number || "—"}`} onClose={() => setViewDoc(null)} width={720}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              ["Status", <StatusBadge status={viewDoc.status} />],
              ["Category", <CategoryBadge category={viewDoc.category} subcategory={viewDoc.subcategory} />],
              ["Pages", viewDoc.page_count || "—"],
              ["Date", viewDoc.document_date || "—"],
              ["Provider", viewDoc.provider_name || "—"],
              ["File Size", viewDoc.file_size ? `${(viewDoc.file_size / 1024 / 1024).toFixed(2)} MB` : "—"],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ background: GRAY_50, borderRadius: 7, padding: "10px 12px" }}>
                <div style={{ fontSize: 11, color: GRAY_400, fontWeight: 600, marginBottom: 3, textTransform: "uppercase" }}>{lbl}</div>
                <div style={{ fontSize: 13, fontWeight: 500, color: GRAY_700 }}>{typeof val === "string" ? val : val}</div>
              </div>
            ))}
          </div>
          {viewDoc.has_duplicate_pages && (
            <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: WARNING, marginBottom: 6 }}>⚠ Duplicate Pages Detected</div>
              {(viewDoc.duplicate_pages || []).slice(0, 3).map((dp, i) => (
                <div key={i} style={{ fontSize: 12, color: GRAY_600, marginBottom: 3 }}>Pages {(dp.page_numbers || []).join(", ")}: {dp.similarity}</div>
              ))}
            </div>
          )}
          {viewDoc.notes && (
            <div style={{ background: GRAY_50, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: GRAY_600, lineHeight: 1.6 }}>
              {viewDoc.notes}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {!["completed", "processed"].includes(viewDoc.status) && (
              <Btn onClick={() => { processDoc(viewDoc); setViewDoc(null); }} variant="success">⚡ Generate AI Summary</Btn>
            )}
            <Btn onClick={async () => {
              try { const r = await awsGet(`/documents/${viewDoc.aws_document_id}/download-url`); window.open(r.download_url, "_blank"); }
              catch (e) { alert("Download failed: " + e.message); }
            }} variant="secondary">⬇ Download PDF</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Medical Summaries ────────────────────────────────────────────────────────
function Summaries({ summaries, patients, documents, onRefresh }) {
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ patient_id: "", document_ids: [], header_note: "", ime_note: "" });
  const [saving, setSaving] = useState(false);

  const filtered = summaries.filter(s =>
    !search || `${s.patient_name || ""} ${s.case_number || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  const saveSummary = async () => {
    if (!form.patient_id) return alert("Select a patient.");
    setSaving(true);
    try {
      await awsPost("/summaries", form);
      setCreating(false); setForm({ patient_id: "", document_ids: [], header_note: "", ime_note: "" }); onRefresh();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const deleteSummary = async (id) => {
    if (!confirm("Delete this summary?")) return;
    try { await awsDelete(`/summaries/${id}`); onRefresh(); } catch (e) { alert(e.message); }
  };

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.h1}>Medical Summaries</h1>
          <p style={s.sub}>{summaries.length} summary{summaries.length !== 1 ? "ies" : "y"}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
          <Btn onClick={() => setCreating(true)}>+ New Summary</Btn>
        </div>
      </div>

      <div style={{ ...s.card, marginBottom: 16, padding: "12px 16px" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by patient or case…" style={{ ...s.input, border: "none", outline: "none", background: "transparent" }} />
      </div>

      {summaries.length === 0 ? (
        <EmptyState icon="📋" title="No summaries yet" sub="Create a summary to document a patient's visit history" action={<Btn onClick={() => setCreating(true)}>Create Summary</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(sum => (
            <div key={sum.aws_summary_id} style={{ ...s.card, display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ width: 42, height: 42, borderRadius: 9, background: "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 }}>📋</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: GRAY_900, marginBottom: 3 }}>{sum.patient_name || "Unknown Patient"}</div>
                <div style={{ fontSize: 12, color: GRAY_500, marginBottom: 6 }}>
                  {sum.case_number && <span style={{ marginRight: 10 }}>📁 {sum.case_number}</span>}
                  {sum.visits?.length > 0 && <span>{sum.visits.length} visit{sum.visits.length !== 1 ? "s" : ""} documented</span>}
                </div>
                {sum.header_note && <div style={{ fontSize: 13, color: GRAY_600, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{sum.header_note}</div>}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Btn onClick={() => setSelected(sum)} variant="secondary" size="sm">View</Btn>
                <Btn onClick={() => deleteSummary(sum.aws_summary_id)} variant="ghost" size="sm" style={{ color: DANGER }}>✕</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View Summary Modal */}
      {selected && (
        <Modal title={`Summary — ${selected.patient_name || "Patient"}`} subtitle={selected.case_number ? `Case: ${selected.case_number}` : undefined} onClose={() => setSelected(null)} width={860}>
          {selected.header_note && (
            <div style={{ background: GRAY_50, borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13.5, color: GRAY_700, lineHeight: 1.7 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: GRAY_400, marginBottom: 6, textTransform: "uppercase" }}>Header Note</div>
              {selected.header_note}
            </div>
          )}
          {selected.visits && selected.visits.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: GRAY_900, marginBottom: 10 }}>Visit Timeline ({selected.visits.length} visits)</div>
              <div style={{ display: "grid", gap: 10, maxHeight: 480, overflow: "auto" }}>
                {selected.visits.map((v, i) => (
                  <div key={i} style={{ background: GRAY_50, borderRadius: 8, padding: 14, borderLeft: `3px solid ${ACCENT}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: GRAY_900 }}>{v.visit_date}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {(v.icd10_codes || []).slice(0, 2).map(c => <Tag key={c} label={c} />)}
                        {v.symptom_progression && <Badge label={v.symptom_progression.replace(/_/g, " ")}
                          color={v.symptom_progression === "improved" ? SUCCESS : v.symptom_progression === "worse" ? DANGER : GRAY_500}
                          bg={v.symptom_progression === "improved" ? "#dcfce7" : v.symptom_progression === "worse" ? "#fee2e2" : GRAY_100} />}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: GRAY_500, marginBottom: 8 }}>
                      {v.rendering_provider && <span style={{ marginRight: 10 }}>👨‍⚕️ {v.rendering_provider}</span>}
                      {v.practice_setting && <span>🏥 {v.practice_setting}</span>}
                    </div>
                    {v.hpi_summary && <div style={{ fontSize: 13, color: GRAY_700, marginBottom: 6, lineHeight: 1.55 }}><strong>HPI:</strong> {v.hpi_summary}</div>}
                    {v.impression_diagnosis && <div style={{ fontSize: 13, color: GRAY_700, marginBottom: 6 }}><strong>Impression:</strong> {v.impression_diagnosis}</div>}
                    {v.physical_exam_findings && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ fontSize: 12, color: GRAY_500, cursor: "pointer" }}>Physical Exam</summary>
                        <div style={{ fontSize: 12.5, color: GRAY_600, lineHeight: 1.6, marginTop: 4, whiteSpace: "pre-line" }}>{v.physical_exam_findings}</div>
                      </details>
                    )}
                    {v.treatment_plan && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ fontSize: 12, color: GRAY_500, cursor: "pointer" }}>Treatment Plan</summary>
                        <div style={{ fontSize: 12.5, color: GRAY_600, lineHeight: 1.6, marginTop: 4 }}>{v.treatment_plan}</div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {selected.ime_note && (
            <div style={{ background: GRAY_50, borderRadius: 8, padding: 14, marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: GRAY_400, marginBottom: 6, textTransform: "uppercase" }}>IME Note</div>
              <div style={{ fontSize: 13.5, color: GRAY_700, lineHeight: 1.7, whiteSpace: "pre-line" }}>{selected.ime_note}</div>
            </div>
          )}
        </Modal>
      )}

      {/* Create Summary Modal */}
      {creating && (
        <Modal title="New Medical Summary" onClose={() => setCreating(false)} width={600}>
          <FormField label="Patient" required>
            <select style={s.select} value={form.patient_id} onChange={e => setForm(f => ({ ...f, patient_id: e.target.value }))}>
              <option value="">Select patient…</option>
              {patients.map(p => <option key={p.aws_patient_id} value={p.aws_patient_id}>{p.patient_name}</option>)}
            </select>
          </FormField>
          <FormField label="Header Note">
            <textarea style={s.textarea} rows={4} value={form.header_note} onChange={e => setForm(f => ({ ...f, header_note: e.target.value }))} placeholder="Introductory narrative…" />
          </FormField>
          <FormField label="IME Note">
            <textarea style={s.textarea} rows={4} value={form.ime_note} onChange={e => setForm(f => ({ ...f, ime_note: e.target.value }))} placeholder="Independent medical exam notes…" />
          </FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setCreating(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveSummary} disabled={saving}>{saving ? "Saving…" : "Create Summary"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patients ─────────────────────────────────────────────────────────────────
function Patients({ patients, documents, onRefresh, onSelectPatient, onNav }) {
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ patient_name: "", date_of_birth: "", case_number: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const filtered = patients.filter(p =>
    !search || `${p.patient_name || ""} ${p.case_number || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  const openNew = () => { setEditing(null); setForm({ patient_name: "", date_of_birth: "", case_number: "", notes: "" }); setShowModal(true); };
  const openEdit = (p) => { setEditing(p); setForm({ patient_name: p.patient_name || "", date_of_birth: p.date_of_birth || "", case_number: p.case_number || "", notes: p.notes || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.patient_name.trim()) return alert("Patient name is required.");
    setSaving(true);
    try {
      if (editing) await awsPut(`/patients/${editing.aws_patient_id}`, form);
      else await awsPost("/patients", form);
      setShowModal(false); onRefresh();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const del = async (p) => {
    if (!confirm(`Delete "${p.patient_name}"?`)) return;
    try { await awsDelete(`/patients/${p.aws_patient_id}`); onRefresh(); } catch (e) { alert(e.message); }
  };

  const docCount = id => documents.filter(d => d.aws_patient_id === id).length;

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.h1}>Patients</h1>
          <p style={s.sub}>{patients.length} patient{patients.length !== 1 ? "s" : ""} on file</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
          <Btn onClick={openNew}>+ New Patient</Btn>
        </div>
      </div>

      <div style={{ ...s.card, marginBottom: 16, padding: "12px 16px" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or case number…"
          style={{ ...s.input, border: "none", outline: "none", background: "transparent" }} />
      </div>

      {patients.length === 0 ? (
        <EmptyState icon="👥" title="No patients yet" sub="Add a patient or upload a document to get started" action={<Btn onClick={openNew}>Add Patient</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filtered.map(p => (
            <div key={p.aws_patient_id} style={{ ...s.card, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: ACCENT_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: ACCENT, flexShrink: 0 }}>
                {(p.patient_name || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => { onSelectPatient(p); onNav("patient-detail"); }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: GRAY_900 }}>{p.patient_name}</div>
                <div style={{ fontSize: 12, color: GRAY_500, marginTop: 2 }}>
                  {p.case_number && <span style={{ marginRight: 10 }}>📁 {p.case_number}</span>}
                  {p.date_of_birth && <span style={{ marginRight: 10 }}>🎂 {p.date_of_birth}</span>}
                  <span>📄 {docCount(p.aws_patient_id)} doc{docCount(p.aws_patient_id) !== 1 ? "s" : ""}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn onClick={() => { onSelectPatient(p); onNav("patient-detail"); }} variant="secondary" size="sm">View</Btn>
                <Btn onClick={() => openEdit(p)} variant="ghost" size="sm">Edit</Btn>
                <Btn onClick={() => del(p)} variant="ghost" size="sm" style={{ color: DANGER }}>Delete</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Patient" : "Add Patient"} onClose={() => setShowModal(false)}>
          <FormField label="Full Name" required>
            <input style={s.input} value={form.patient_name} onChange={e => setForm(f => ({ ...f, patient_name: e.target.value }))} placeholder="e.g. Silvia Guzman" />
          </FormField>
          <FormField label="Date of Birth">
            <input style={s.input} value={form.date_of_birth} onChange={e => setForm(f => ({ ...f, date_of_birth: e.target.value }))} placeholder="MM/DD/YYYY" />
          </FormField>
          <FormField label="Case Number">
            <input style={s.input} value={form.case_number} onChange={e => setForm(f => ({ ...f, case_number: e.target.value }))} placeholder="e.g. 4A2505HTQH00001" />
          </FormField>
          <FormField label="Notes">
            <textarea style={s.textarea} rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Add Patient"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patient Detail ───────────────────────────────────────────────────────────
function PatientDetail({ patient, documents, summaries, onBack }) {
  const docs = documents.filter(d => d.aws_patient_id === patient.aws_patient_id);
  const sums = summaries.filter(s => s.aws_patient_id === patient.aws_patient_id);
  const [tab, setTab] = useState("documents");

  return (
    <div style={s.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Btn onClick={onBack} variant="secondary" size="sm">← Back</Btn>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: ACCENT_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: ACCENT }}>
          {(patient.patient_name || "?")[0].toUpperCase()}
        </div>
        <div>
          <h1 style={{ ...s.h1, fontSize: 19 }}>{patient.patient_name}</h1>
          {patient.case_number && <p style={s.sub}>Case: {patient.case_number}</p>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={{ ...s.card }}><div style={{ fontSize: 11, color: GRAY_400, fontWeight: 600, marginBottom: 2 }}>DOCUMENTS</div><div style={{ fontSize: 22, fontWeight: 800 }}>{docs.length}</div></div>
        <div style={{ ...s.card }}><div style={{ fontSize: 11, color: GRAY_400, fontWeight: 600, marginBottom: 2 }}>SUMMARIES</div><div style={{ fontSize: 22, fontWeight: 800 }}>{sums.length}</div></div>
        <div style={{ ...s.card }}><div style={{ fontSize: 11, color: GRAY_400, fontWeight: 600, marginBottom: 2 }}>PROCESSED</div><div style={{ fontSize: 22, fontWeight: 800 }}>{docs.filter(d => ["completed", "processed"].includes(d.status)).length}</div></div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <Pill active={tab === "documents"} onClick={() => setTab("documents")}>📄 Documents ({docs.length})</Pill>
        <Pill active={tab === "summaries"} onClick={() => setTab("summaries")}>📋 Summaries ({sums.length})</Pill>
      </div>

      {tab === "documents" && (
        docs.length === 0 ? <EmptyState icon="📄" title="No documents for this patient" /> :
          <div style={{ display: "grid", gap: 8 }}>
            {docs.map(d => (
              <div key={d.aws_document_id} style={{ ...s.card, display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{d.title || d.file_name}</div>
                  <div style={{ fontSize: 12, color: GRAY_500 }}>{d.category} · {d.document_date || "—"}</div>
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))}
          </div>
      )}

      {tab === "summaries" && (
        sums.length === 0 ? <EmptyState icon="📋" title="No summaries for this patient" /> :
          <div style={{ display: "grid", gap: 8 }}>
            {sums.map(sum => (
              <div key={sum.aws_summary_id} style={{ ...s.card }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{sum.patient_name}</div>
                {sum.visits?.length > 0 && <div style={{ fontSize: 12, color: GRAY_500 }}>{sum.visits.length} visits documented</div>}
              </div>
            ))}
          </div>
      )}
    </div>
  );
}

// ─── Notes Macros ─────────────────────────────────────────────────────────────
function NotesMacros() {
  const [macros, setMacros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", content: "", section: "" });
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setMacros(await NotesMacro.list()); } catch (e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const sections = ["all", ...new Set(macros.map(m => m.section).filter(Boolean))];
  const filtered = macros.filter(m => {
    if (sectionFilter !== "all" && m.section !== sectionFilter) return false;
    if (search && !`${m.name} ${m.section} ${m.content}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openNew = () => { setEditing(null); setForm({ name: "", content: "", section: "" }); setShowModal(true); };
  const openEdit = (m) => { setEditing(m); setForm({ name: m.name || "", content: m.content || "", section: m.section || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.name.trim()) return alert("Name is required.");
    try {
      if (editing) await NotesMacro.update(editing.id, form);
      else await NotesMacro.create(form);
      setShowModal(false); load();
    } catch (e) { alert(e.message); }
  };

  const del = async (m) => {
    if (!confirm(`Delete macro "${m.name}"?`)) return;
    try { await NotesMacro.delete(m.id); load(); } catch (e) { alert(e.message); }
  };

  const copy = (m) => {
    navigator.clipboard?.writeText(m.content);
    setCopiedId(m.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div><h1 style={s.h1}>Notes Macros</h1><p style={s.sub}>Reusable text templates for clinical documentation</p></div>
        <Btn onClick={openNew}>+ New Macro</Btn>
      </div>

      <div style={{ ...s.card, marginBottom: 16, padding: "12px 16px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search macros…" style={{ ...s.input, flex: 1, border: "none", outline: "none", background: "transparent" }} />
          <select value={sectionFilter} onChange={e => setSectionFilter(e.target.value)} style={{ ...s.select, width: "auto", minWidth: 130 }}>
            {sections.map(s => <option key={s} value={s}>{s === "all" ? "All Sections" : s}</option>)}
          </select>
        </div>
      </div>

      {loading ? <Spinner /> : filtered.length === 0 ? (
        <EmptyState icon="📝" title="No macros found" sub="Create reusable text snippets for your clinical notes" action={<Btn onClick={openNew}>Create First Macro</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filtered.map(m => (
            <div key={m.id} style={{ ...s.card, display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: GRAY_900 }}>{m.name}</span>
                  {m.section && <Badge label={m.section} color="#7c3aed" bg="#ede9fe" />}
                </div>
                <div style={{ fontSize: 13, color: GRAY_500, lineHeight: 1.55, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{m.content}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Btn onClick={() => copy(m)} variant="secondary" size="sm">{copiedId === m.id ? "✓ Copied" : "Copy"}</Btn>
                <Btn onClick={() => openEdit(m)} variant="ghost" size="sm">Edit</Btn>
                <Btn onClick={() => del(m)} variant="ghost" size="sm" style={{ color: DANGER }}>Del</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Macro" : "New Macro"} onClose={() => setShowModal(false)}>
          <FormField label="Name" required><input style={s.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Normal Gait Exam" /></FormField>
          <FormField label="Section"><input style={s.input} value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value }))} placeholder="e.g. Physical Exam, HPI, Assessment" /></FormField>
          <FormField label="Content"><textarea style={s.textarea} rows={7} value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} placeholder="Enter macro text…" /></FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save}>{editing ? "Save Changes" : "Create Macro"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────
function Admin() {
  const [tab, setTab] = useState("suggestions");
  const [suggestions, setSuggestions] = useState([]);
  const [breaches, setBreaches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showBreachModal, setShowBreachModal] = useState(false);
  const [showSugModal, setShowSugModal] = useState(false);
  const [bForm, setBForm] = useState({ event_type: "", severity: "medium", description: "", affected_users: "", investigation_notes: "", status: "open" });
  const [sForm, setSForm] = useState({ title: "", description: "", category: "Feature Request", priority: "medium" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sg, br] = await Promise.all([Suggestion.list(), BreachNotification.list()]);
      setSuggestions(sg); setBreaches(br);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveBreach = async () => {
    if (!bForm.description.trim()) return alert("Description required.");
    try {
      await BreachNotification.create({ ...bForm, detected_date: new Date().toISOString(), notification_sent: false });
      setShowBreachModal(false); setBForm({ event_type: "", severity: "medium", description: "", affected_users: "", investigation_notes: "", status: "open" }); load();
    } catch (e) { alert(e.message); }
  };

  const saveSug = async () => {
    if (!sForm.title.trim()) return alert("Title required.");
    try { await Suggestion.create(sForm); setShowSugModal(false); setSForm({ title: "", description: "", category: "Feature Request", priority: "medium" }); load(); } catch (e) { alert(e.message); }
  };

  const toggleBreachStatus = async (b) => {
    try { await BreachNotification.update(b.id, { status: b.status === "resolved" ? "open" : "resolved" }); load(); } catch (e) { alert(e.message); }
  };

  const updateSugStatus = async (sg, status) => {
    try { await Suggestion.update(sg.id, { status }); load(); } catch (e) { alert(e.message); }
  };

  const sevColor = { low: SUCCESS, medium: WARNING, high: DANGER, critical: "#7f1d1d" };
  const sevBg = { low: "#dcfce7", medium: "#fef3c7", high: "#fee2e2", critical: "#fce7f3" };

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <div><h1 style={s.h1}>Admin</h1><p style={s.sub}>Manage suggestions and HIPAA breach notifications</p></div>
        <div style={{ display: "flex", gap: 8 }}>
          {tab === "breaches" && <Btn onClick={() => setShowBreachModal(true)} variant="danger">+ Report Breach</Btn>}
          {tab === "suggestions" && <Btn onClick={() => setShowSugModal(true)}>+ Add Suggestion</Btn>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Pill active={tab === "suggestions"} onClick={() => setTab("suggestions")}>💡 Suggestions ({suggestions.length})</Pill>
        <Pill active={tab === "breaches"} onClick={() => setTab("breaches")}>🔒 Breach Log ({breaches.length})</Pill>
      </div>

      {loading ? <Spinner /> : tab === "suggestions" ? (
        suggestions.length === 0 ? <EmptyState icon="💡" title="No suggestions yet" /> :
          <div style={{ display: "grid", gap: 8 }}>
            {suggestions.map(sg => (
              <div key={sg.id} style={{ ...s.card, display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "center" }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{sg.title}</span>
                    {sg.category && <Badge label={sg.category} color={GRAY_500} bg={GRAY_100} />}
                    {sg.priority && <Badge label={sg.priority} color={sevColor[sg.priority] || GRAY_500} bg={sevBg[sg.priority] || GRAY_100} />}
                  </div>
                  {sg.description && <div style={{ fontSize: 13, color: GRAY_500 }}>{sg.description}</div>}
                  {sg.admin_notes && <div style={{ fontSize: 12, color: GRAY_400, marginTop: 4, fontStyle: "italic" }}>Admin: {sg.admin_notes}</div>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <StatusBadge status={sg.status || "pending"} />
                  <select value={sg.status || "pending"} onChange={e => updateSugStatus(sg, e.target.value)} style={{ ...s.select, width: 120, fontSize: 12 }}>
                    {["pending", "reviewing", "planned", "completed", "rejected"].map(v => <option key={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
      ) : (
        breaches.length === 0 ? <EmptyState icon="🔒" title="No breach events logged" sub="All clear — no security incidents recorded" /> :
          <div style={{ display: "grid", gap: 8 }}>
            {breaches.map(b => (
              <div key={b.id} style={{ ...s.card, display: "flex", gap: 12, borderLeft: `4px solid ${sevColor[b.severity] || GRAY_400}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{b.event_type || "Security Event"}</span>
                    <Badge label={b.severity || "medium"} color={sevColor[b.severity] || GRAY_500} bg={sevBg[b.severity] || GRAY_100} />
                    <StatusBadge status={b.status || "open"} />
                  </div>
                  <div style={{ fontSize: 13, color: GRAY_600, marginBottom: 4 }}>{b.description}</div>
                  <div style={{ fontSize: 11.5, color: GRAY_400 }}>
                    {b.affected_users && <span style={{ marginRight: 10 }}>Affected: {b.affected_users}</span>}
                    {b.detected_date && <span>Detected: {new Date(b.detected_date).toLocaleString()}</span>}
                  </div>
                  {b.investigation_notes && <div style={{ fontSize: 12, color: GRAY_500, marginTop: 4, fontStyle: "italic" }}>Notes: {b.investigation_notes}</div>}
                </div>
                <Btn onClick={() => toggleBreachStatus(b)} variant={b.status === "resolved" ? "secondary" : "success"} size="sm">
                  {b.status === "resolved" ? "Reopen" : "Resolve"}
                </Btn>
              </div>
            ))}
          </div>
      )}

      {showBreachModal && (
        <Modal title="Report Security Breach" subtitle="This will be logged for HIPAA compliance" onClose={() => setShowBreachModal(false)}>
          <FormField label="Event Type"><input style={s.input} value={bForm.event_type} onChange={e => setBForm(f => ({ ...f, event_type: e.target.value }))} placeholder="e.g. Unauthorized Access, Data Exposure" /></FormField>
          <FormField label="Severity">
            <select style={s.select} value={bForm.severity} onChange={e => setBForm(f => ({ ...f, severity: e.target.value }))}>
              {["low", "medium", "high", "critical"].map(v => <option key={v}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Description" required><textarea style={s.textarea} rows={4} value={bForm.description} onChange={e => setBForm(f => ({ ...f, description: e.target.value }))} /></FormField>
          <FormField label="Affected Users / Records"><input style={s.input} value={bForm.affected_users} onChange={e => setBForm(f => ({ ...f, affected_users: e.target.value }))} placeholder="e.g. 0 identified" /></FormField>
          <FormField label="Investigation Notes"><textarea style={s.textarea} rows={3} value={bForm.investigation_notes} onChange={e => setBForm(f => ({ ...f, investigation_notes: e.target.value }))} /></FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowBreachModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveBreach} variant="danger">Submit Report</Btn>
          </div>
        </Modal>
      )}

      {showSugModal && (
        <Modal title="Add Suggestion" onClose={() => setShowSugModal(false)}>
          <FormField label="Title" required><input style={s.input} value={sForm.title} onChange={e => setSForm(f => ({ ...f, title: e.target.value }))} /></FormField>
          <FormField label="Description"><textarea style={s.textarea} rows={4} value={sForm.description} onChange={e => setSForm(f => ({ ...f, description: e.target.value }))} /></FormField>
          <FormField label="Category">
            <select style={s.select} value={sForm.category} onChange={e => setSForm(f => ({ ...f, category: e.target.value }))}>
              {["Feature Request", "Bug Report", "UI Improvement", "Performance", "Other"].map(v => <option key={v}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Priority">
            <select style={s.select} value={sForm.priority} onChange={e => setSForm(f => ({ ...f, priority: e.target.value }))}>
              {["low", "medium", "high"].map(v => <option key={v}>{v}</option>)}
            </select>
          </FormField>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowSugModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveSug}>Submit</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [patients, setPatients] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPatient, setSelectedPatient] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const pData = await awsGet("/patients").catch(() => ({ patients: [] }));
      const pts = pData.patients || [];
      setPatients(pts);

      if (pts.length > 0) {
        const docResults = await Promise.all(pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(() => [])));
        const allDocs = docResults.flat();
        setDocuments(allDocs);

        // Load summaries via AWS summaries endpoint if available
        const sumResults = await Promise.all(
          pts.map(p => awsGet(`/summaries?patient_id=${p.aws_patient_id}`).catch(() => ({ summaries: [] })))
        );
        setSummaries(sumResults.flatMap(r => r.summaries || []));
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const nav = (p) => setPage(p);

  const counts = { patients: patients.length, documents: documents.length, summaries: summaries.length };

  const renderPage = () => {
    if (loading) return <Spinner text="Loading ChartReview Pro…" />;
    switch (page) {
      case "dashboard": return <Dashboard onNav={nav} patients={patients} documents={documents} summaries={summaries} />;
      case "documents": return <Documents patients={patients} documents={documents} onRefresh={loadAll} />;
      case "summaries": return <Summaries summaries={summaries} patients={patients} documents={documents} onRefresh={loadAll} />;
      case "patients": return <Patients patients={patients} documents={documents} onRefresh={loadAll} onSelectPatient={setSelectedPatient} onNav={nav} />;
      case "patient-detail": return selectedPatient ? <PatientDetail patient={selectedPatient} documents={documents} summaries={summaries} onBack={() => nav("patients")} /> : null;
      case "macros": return <NotesMacros />;
      case "admin": return <Admin />;
      default: return null;
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: GRAY_50, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <Sidebar page={page} onNav={nav} counts={counts} />
      <div style={{ flex: 1, overflow: "auto" }}>{renderPage()}</div>
    </div>
  );
}
