import { useState, useEffect, useCallback } from "react";

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

// ─── Design Tokens ────────────────────────────────────────────────────────────
const C = {
  navy: "#1e3a5f",
  navyLight: "#2a4f7c",
  blue: "#3b82f6",
  blueLight: "#eff6ff",
  green: "#10b981",
  greenLight: "#ecfdf5",
  amber: "#f59e0b",
  amberLight: "#fffbeb",
  red: "#ef4444",
  redLight: "#fef2f2",
  purple: "#8b5cf6",
  purpleLight: "#f5f3ff",
  gray50: "#f8fafc",
  gray100: "#f1f5f9",
  gray200: "#e2e8f0",
  gray400: "#94a3b8",
  gray500: "#64748b",
  gray700: "#334155",
  gray900: "#0f172a",
  white: "#ffffff",
};

// ─── Shared Components ────────────────────────────────────────────────────────
function Sidebar({ current, onNav, patientCount, docCount, summaryCount }) {
  const nav = [
    { id: "dashboard", icon: "🏠", label: "Dashboard" },
    { id: "patients", icon: "👤", label: "Patients", badge: patientCount },
    { id: "documents", icon: "📄", label: "Documents", badge: docCount },
    { id: "summaries", icon: "📋", label: "Summaries", badge: summaryCount },
    { id: "macros", icon: "📝", label: "Notes Macros" },
    { id: "admin", icon: "⚙️", label: "Admin" },
  ];
  return (
    <div style={{ width: 230, background: C.navy, color: C.white, display: "flex", flexDirection: "column", minHeight: "100vh", flexShrink: 0 }}>
      <div style={{ padding: "28px 20px 20px" }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.3px" }}>ChartReview Pro</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: C.green }}>●</span> HIPAA Compliant · AWS
        </div>
      </div>
      <nav style={{ flex: 1, padding: "4px 10px" }}>
        {nav.map(item => {
          const active = current === item.id;
          return (
            <button key={item.id} onClick={() => onNav(item.id)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              width: "100%", padding: "10px 12px", border: "none",
              background: active ? "rgba(255,255,255,0.12)" : "transparent",
              color: active ? C.white : "rgba(255,255,255,0.65)",
              cursor: "pointer", fontSize: 13.5, fontWeight: active ? 600 : 400,
              borderRadius: 8, marginBottom: 2,
              borderLeft: active ? `3px solid ${C.blue}` : "3px solid transparent",
              transition: "all 0.15s",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span>{item.icon}</span><span>{item.label}</span>
              </span>
              {item.badge > 0 && (
                <span style={{ background: active ? C.blue : "rgba(255,255,255,0.15)", color: C.white, fontSize: 11, padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>{item.badge}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
        🔒 PHI stored on AWS · BAA Active
      </div>
    </div>
  );
}

function Btn({ onClick, children, variant = "primary", size = "md", style = {}, disabled }) {
  const variants = {
    primary: { background: C.navy, color: C.white, border: "none" },
    secondary: { background: C.white, color: C.navy, border: `1px solid ${C.gray200}` },
    danger: { background: C.red, color: C.white, border: "none" },
    success: { background: C.green, color: C.white, border: "none" },
    ghost: { background: "transparent", color: C.gray500, border: "none" },
    blue: { background: C.blue, color: C.white, border: "none" },
  };
  const sizes = {
    sm: { padding: "5px 12px", fontSize: 12 },
    md: { padding: "8px 16px", fontSize: 13.5 },
    lg: { padding: "11px 22px", fontSize: 15 },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 500,
      opacity: disabled ? 0.55 : 1, transition: "opacity 0.15s",
      ...variants[variant], ...sizes[size], ...style
    }}>{children}</button>
  );
}

function Card({ children, style = {}, onClick, hover }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => hover && setHov(true)}
      onMouseLeave={() => hover && setHov(false)}
      style={{
        background: C.white, borderRadius: 12, border: `1px solid ${C.gray200}`,
        padding: 20, cursor: onClick ? "pointer" : "default",
        boxShadow: hov ? "0 4px 16px rgba(0,0,0,0.08)" : "none",
        transition: "box-shadow 0.15s", ...style
      }}>{children}</div>
  );
}

function Badge({ text, color = C.gray500, bg = C.gray100, style = {} }) {
  return <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, color, background: bg, whiteSpace: "nowrap", ...style }}>{text}</span>;
}

function Modal({ title, onClose, children, width = 600, subtitle }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 32, width, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: C.navy }}>{title}</h2>
            {subtitle && <p style={{ margin: "4px 0 0", color: C.gray500, fontSize: 13 }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} style={{ background: C.gray100, border: "none", width: 32, height: 32, borderRadius: 8, cursor: "pointer", fontSize: 16, color: C.gray500, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, required, as = "input", rows = 3, options }) {
  const base = { width: "100%", padding: "9px 12px", border: `1px solid ${C.gray200}`, borderRadius: 8, fontSize: 14, boxSizing: "border-box", outline: "none", color: C.gray900, background: C.white };
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.gray700, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.4px" }}>
        {label}{required && <span style={{ color: C.red }}> *</span>}
      </label>}
      {as === "textarea" ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder} style={{ ...base, resize: "vertical" }} />
      ) : as === "select" ? (
        <select value={value} onChange={e => onChange(e.target.value)} style={base}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={base} />
      )}
    </div>
  );
}

function Spinner() {
  return <div style={{ textAlign: "center", padding: "60px 0", color: C.gray400, fontSize: 14 }}>Loading...</div>;
}

function Empty({ icon = "📭", message, action }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: C.gray400 }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 15, marginBottom: 20, color: C.gray500 }}>{message}</div>
      {action}
    </div>
  );
}

function StatCard({ icon, label, value, color, onClick }) {
  return (
    <Card hover={!!onClick} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.gray900 }}>{value}</div>
        <div style={{ fontSize: 13, color: C.gray500, marginTop: 1 }}>{label}</div>
      </div>
    </Card>
  );
}

function SectionHeader({ title, subtitle, action }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.navy }}>{title}</h1>
        {subtitle && <p style={{ margin: "3px 0 0", color: C.gray500, fontSize: 13 }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function SearchBar({ value, onChange, placeholder = "Search...", onRefresh }) {
  return (
    <Card style={{ marginBottom: 16, padding: "12px 16px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ color: C.gray400, fontSize: 15 }}>🔍</span>
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: C.gray900, background: "transparent" }} />
        {value && <Btn onClick={() => onChange("")} variant="ghost" size="sm">✕</Btn>}
        {onRefresh && <Btn onClick={onRefresh} variant="secondary" size="sm">↻ Refresh</Btn>}
      </div>
    </Card>
  );
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    uploaded: { text: "Uploaded", color: C.gray500, bg: C.gray100 },
    processing: { text: "Processing…", color: C.amber, bg: C.amberLight },
    processed: { text: "Processed ✓", color: C.green, bg: C.greenLight },
    completed: { text: "Completed ✓", color: C.green, bg: C.greenLight },
    failed: { text: "Failed", color: C.red, bg: C.redLight },
    pending: { text: "Pending", color: C.amber, bg: C.amberLight },
  };
  const s = map[status] || map.uploaded;
  return <Badge text={s.text} color={s.color} bg={s.bg} />;
}

function categoryBadge(cat) {
  const map = {
    medical: { color: C.blue, bg: C.blueLight },
    legal: { color: C.purple, bg: C.purpleLight },
    other: { color: C.gray500, bg: C.gray100 },
  };
  const s = map[cat] || map.other;
  return <Badge text={cat || "other"} color={s.color} bg={s.bg} />;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ onNav, patients, documents, summaries }) {
  const recentDocs = [...documents].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 5);
  const processed = documents.filter(d => d.status === "processed" || d.status === "completed").length;

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="Dashboard" subtitle="Welcome to ChartReview Pro" />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard icon="👤" label="Patients" value={patients.length} color={C.blue} onClick={() => onNav("patients")} />
        <StatCard icon="📄" label="Documents" value={documents.length} color={C.green} onClick={() => onNav("documents")} />
        <StatCard icon="✅" label="Processed" value={processed} color={C.purple} />
        <StatCard icon="📋" label="Summaries" value={summaries.length} color={C.amber} onClick={() => onNav("summaries")} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.navy, marginBottom: 14 }}>Recent Documents</div>
          {recentDocs.length === 0 ? (
            <div style={{ color: C.gray400, fontSize: 13, textAlign: "center", padding: 20 }}>No documents yet</div>
          ) : recentDocs.map(d => (
            <div key={d.aws_document_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.gray100}` }}>
              <span style={{ fontSize: 18 }}>📄</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: C.gray900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || d.file_name}</div>
                {d.patient_name && <div style={{ fontSize: 12, color: C.gray500 }}>👤 {d.patient_name}</div>}
              </div>
              {statusBadge(d.status)}
            </div>
          ))}
        </Card>

        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.navy, marginBottom: 14 }}>Patients</div>
          {patients.length === 0 ? (
            <div style={{ color: C.gray400, fontSize: 13, textAlign: "center", padding: 20 }}>No patients yet</div>
          ) : patients.slice(0, 6).map(p => (
            <div key={p.aws_patient_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.gray100}` }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.blueLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.blue, flexShrink: 0 }}>
                {(p.patient_name || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: C.gray900 }}>{p.patient_name}</div>
                {p.case_number && <div style={{ fontSize: 12, color: C.gray500 }}>Case: {p.case_number}</div>}
              </div>
            </div>
          ))}
          {patients.length > 6 && <div style={{ fontSize: 12, color: C.blue, marginTop: 8, cursor: "pointer" }} onClick={() => onNav("patients")}>View all {patients.length} patients →</div>}
        </Card>
      </div>
    </div>
  );
}

// ─── Patients ─────────────────────────────────────────────────────────────────
function Patients({ patients, documents, onNav, onSelectPatient, onRefresh }) {
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ patient_name: "", date_of_birth: "", case_number: "", notes: "" });

  const filtered = patients.filter(p =>
    `${p.patient_name || ""} ${p.case_number || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  const openNew = () => { setEditing(null); setForm({ patient_name: "", date_of_birth: "", case_number: "", notes: "" }); setShowModal(true); };
  const openEdit = (p) => { setEditing(p); setForm({ patient_name: p.patient_name || "", date_of_birth: p.date_of_birth || "", case_number: p.case_number || "", notes: p.notes || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.patient_name.trim()) return alert("Patient name is required.");
    setSaving(true);
    try {
      if (editing) await awsPut(`/patients/${editing.aws_patient_id}`, form);
      else await awsPost("/patients", form);
      setShowModal(false);
      onRefresh();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const del = async (p) => {
    if (!confirm(`Delete patient "${p.patient_name}"? This cannot be undone.`)) return;
    try { await awsDelete(`/patients/${p.aws_patient_id}`); onRefresh(); } catch (e) { alert(e.message); }
  };

  const docCount = (id) => documents.filter(d => d.aws_patient_id === id).length;

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="Patients" subtitle={`${patients.length} patient${patients.length !== 1 ? "s" : ""} on file`}
        action={<Btn onClick={openNew}>+ New Patient</Btn>} />
      <SearchBar value={search} onChange={setSearch} placeholder="Search by name or case number..." onRefresh={onRefresh} />

      {filtered.length === 0 ? (
        <Empty icon="👤" message="No patients found" action={<Btn onClick={openNew}>Add First Patient</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(p => (
            <Card key={p.aws_patient_id} hover style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: C.blueLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: C.blue, flexShrink: 0 }}>
                {(p.patient_name || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => { onSelectPatient(p); onNav("patient-detail"); }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.gray900 }}>{p.patient_name}</div>
                <div style={{ fontSize: 12.5, color: C.gray500, marginTop: 2 }}>
                  {p.case_number && <span style={{ marginRight: 10 }}>📁 Case: {p.case_number}</span>}
                  {p.date_of_birth && <span style={{ marginRight: 10 }}>🎂 DOB: {p.date_of_birth}</span>}
                  <span>📄 {docCount(p.aws_patient_id)} document{docCount(p.aws_patient_id) !== 1 ? "s" : ""}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn onClick={() => { onSelectPatient(p); onNav("patient-detail"); }} variant="secondary" size="sm">View</Btn>
                <Btn onClick={() => openEdit(p)} variant="ghost" size="sm">Edit</Btn>
                <Btn onClick={() => del(p)} variant="ghost" size="sm" style={{ color: C.red }}>Delete</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Patient" : "New Patient"} onClose={() => setShowModal(false)}>
          <Field label="Patient Name" value={form.patient_name} onChange={v => setForm(p => ({ ...p, patient_name: v }))} required />
          <Field label="Date of Birth" value={form.date_of_birth} onChange={v => setForm(p => ({ ...p, date_of_birth: v }))} placeholder="MM/DD/YYYY" />
          <Field label="Case Number" value={form.case_number} onChange={v => setForm(p => ({ ...p, case_number: v }))} />
          <Field label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} as="textarea" rows={3} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Create Patient"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patient Detail ───────────────────────────────────────────────────────────
function PatientDetail({ patient, documents, summaries, onBack, onNav }) {
  const patientDocs = documents.filter(d => d.aws_patient_id === patient.aws_patient_id);
  const patientSummaries = summaries.filter(s => s.aws_patient_id === patient.aws_patient_id);

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Btn onClick={onBack} variant="secondary" size="sm">← Back</Btn>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.navy }}>{patient.patient_name}</h1>
        {patient.case_number && <Badge text={`Case: ${patient.case_number}`} color={C.blue} bg={C.blueLight} />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
        <StatCard icon="📄" label="Documents" value={patientDocs.length} color={C.blue} />
        <StatCard icon="📋" label="Summaries" value={patientSummaries.length} color={C.purple} />
        <StatCard icon="✅" label="Processed" value={patientDocs.filter(d => d.status === "processed" || d.status === "completed").length} color={C.green} />
      </div>

      {patient.notes && (
        <Card style={{ marginBottom: 20, background: C.gray50 }}>
          <div style={{ fontSize: 12.5, color: C.gray500, fontWeight: 600, marginBottom: 4 }}>NOTES</div>
          <div style={{ fontSize: 14, color: C.gray700 }}>{patient.notes}</div>
        </Card>
      )}

      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.navy, marginBottom: 14 }}>Documents</div>
        {patientDocs.length === 0 ? (
          <div style={{ color: C.gray400, textAlign: "center", padding: 24, fontSize: 13 }}>No documents for this patient</div>
        ) : patientDocs.map(d => (
          <div key={d.aws_document_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.gray100}` }}>
            <span style={{ fontSize: 20 }}>📄</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.gray900 }}>{d.title || d.file_name}</div>
              <div style={{ fontSize: 12, color: C.gray500 }}>{d.category} · {d.created_at ? new Date(d.created_at).toLocaleDateString() : "—"}</div>
            </div>
            {statusBadge(d.status)}
          </div>
        ))}
      </Card>

      {patientSummaries.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.navy, marginBottom: 14 }}>AI Summaries</div>
          {patientSummaries.map(s => (
            <div key={s.aws_summary_id} style={{ padding: "12px 0", borderBottom: `1px solid ${C.gray100}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.gray900, marginBottom: 4 }}>{s.document_title || "Summary"}</div>
              <div style={{ fontSize: 13, color: C.gray600, lineHeight: 1.6 }}>{(s.summary || "").substring(0, 300)}…</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────
function Documents({ patients, documents, onRefresh }) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [showUpload, setShowUpload] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState({});
  const [file, setFile] = useState(null);
  const [uploadForm, setUploadForm] = useState({ patient_name: "", title: "", category: "Medical Records" });

  const categories = ["Medical Records", "Imaging", "Lab Results", "Operative Notes", "Discharge Summary", "Consultation", "Physical Therapy", "Mental Health", "Legal", "Other"];

  const filtered = documents.filter(d => {
    const q = search.toLowerCase();
    const matchQ = !search || `${d.patient_name || ""} ${d.title || ""} ${d.file_name || ""}`.toLowerCase().includes(q);
    const matchCat = catFilter === "all" || (d.category || "").toLowerCase() === catFilter;
    return matchQ && matchCat;
  });

  const uploadDoc = async () => {
    if (!file) return alert("Please select a file.");
    if (!uploadForm.patient_name.trim()) return alert("Please enter a patient name.");
    setUploading(true);
    try {
      const pRes = await awsPost("/patients", { patient_name: uploadForm.patient_name.trim() });
      const awsPatientId = pRes?.aws_patient_id || null;
      const docPayload = {
        aws_patient_id: awsPatientId,
        patient_name: uploadForm.patient_name.trim(),
        file_name: file.name,
        content_type: file.type || "application/octet-stream",
        title: uploadForm.title || file.name,
        category: uploadForm.category,
      };
      const uploadData = await awsPost("/documents/upload-url", docPayload);
      if (!uploadData.upload_url) throw new Error("No upload URL returned");
      const s3Res = await fetch(uploadData.upload_url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!s3Res.ok) throw new Error("S3 upload failed: " + s3Res.status);
      await awsPost(`/documents/${uploadData.aws_document_id}/process`, {}).catch(() => {});
      alert("Document uploaded! AI summary is generating — refresh in a moment.");
      setShowUpload(false); setFile(null);
      setUploadForm({ patient_name: "", title: "", category: "Medical Records" });
      onRefresh();
    } catch (e) { alert("Upload failed: " + e.message); }
    setUploading(false);
  };

  const processDoc = async (doc) => {
    setProcessing(p => ({ ...p, [doc.aws_document_id]: true }));
    try {
      const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      alert("✅ Summary generated!\n\n" + (res.summary || "").substring(0, 500));
      onRefresh();
    } catch (e) { alert("Processing failed: " + e.message); }
    setProcessing(p => ({ ...p, [doc.aws_document_id]: false }));
  };

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="Documents" subtitle={`${documents.length} document${documents.length !== 1 ? "s" : ""}`}
        action={<Btn onClick={() => setShowUpload(true)}>+ Upload Document</Btn>} />

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search by patient, title…" onRefresh={onRefresh} />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          style={{ padding: "0 14px", border: `1px solid ${C.gray200}`, borderRadius: 8, fontSize: 13.5, color: C.gray700, background: C.white, cursor: "pointer" }}>
          <option value="all">All Categories</option>
          <option value="medical">Medical</option>
          <option value="legal">Legal</option>
          <option value="other">Other</option>
        </select>
      </div>

      {documents.length === 0 ? (
        <Empty icon="📄" message="No documents uploaded yet" action={<Btn onClick={() => setShowUpload(true)}>Upload First Document</Btn>} />
      ) : filtered.length === 0 ? (
        <Empty icon="🔍" message="No documents match your search" />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(d => (
            <Card key={d.aws_document_id} hover style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: C.blueLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>📄</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: C.gray900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || d.file_name}</div>
                <div style={{ fontSize: 12.5, color: C.gray500, marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {d.patient_name && <span>👤 {d.patient_name}</span>}
                  {d.category && categoryBadge(d.category)}
                  {d.created_at && <span>📅 {new Date(d.created_at).toLocaleDateString()}</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {statusBadge(d.status)}
                {(d.status === "uploaded" || d.status === "failed") && (
                  <Btn onClick={() => processDoc(d)} variant="blue" size="sm" disabled={processing[d.aws_document_id]}>
                    {processing[d.aws_document_id] ? "…" : "⚡ Process"}
                  </Btn>
                )}
                <Btn onClick={() => setSelectedDoc(d)} variant="secondary" size="sm">View</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showUpload && (
        <Modal title="Upload Document" subtitle="Document will be processed by AI automatically" onClose={() => { setShowUpload(false); setFile(null); }}>
          <Field label="Patient Name" value={uploadForm.patient_name} onChange={v => setUploadForm(f => ({ ...f, patient_name: v }))} placeholder="e.g. John Smith" required />
          <Field label="Document Title" value={uploadForm.title} onChange={v => setUploadForm(f => ({ ...f, title: v }))} placeholder="Leave blank to use filename" />
          <Field label="Category" value={uploadForm.category} onChange={v => setUploadForm(f => ({ ...f, category: v }))} as="select"
            options={categories.map(c => ({ value: c, label: c }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.gray700, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.4px" }}>
              File <span style={{ color: C.red }}>*</span>
            </label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.tiff" onChange={e => setFile(e.target.files[0])} style={{ fontSize: 14 }} />
            {file && <div style={{ marginTop: 6, fontSize: 12, color: C.gray500 }}>📎 {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</div>}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={() => { setShowUpload(false); setFile(null); }} variant="secondary">Cancel</Btn>
            <Btn onClick={uploadDoc} disabled={uploading}>{uploading ? "Uploading…" : "Upload & Process"}</Btn>
          </div>
        </Modal>
      )}

      {selectedDoc && (
        <Modal title={selectedDoc.title || selectedDoc.file_name} subtitle={`Patient: ${selectedDoc.patient_name || "—"}`} onClose={() => setSelectedDoc(null)} width={700}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
            <div style={{ background: C.gray50, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: C.gray500, fontWeight: 600, marginBottom: 3 }}>STATUS</div>
              {statusBadge(selectedDoc.status)}
            </div>
            <div style={{ background: C.gray50, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: C.gray500, fontWeight: 600, marginBottom: 3 }}>CATEGORY</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{selectedDoc.category || "—"}</div>
            </div>
            <div style={{ background: C.gray50, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: C.gray500, fontWeight: 600, marginBottom: 3 }}>UPLOADED</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{selectedDoc.created_at ? new Date(selectedDoc.created_at).toLocaleDateString() : "—"}</div>
            </div>
          </div>
          {selectedDoc.aws_summary_id && (
            <div style={{ background: C.greenLight, border: `1px solid #6ee7b7`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#065f46" }}>✓ AI Summary Generated</div>
              <div style={{ fontSize: 12, color: "#047857", marginTop: 2 }}>Summary ID: {selectedDoc.aws_summary_id}</div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {(selectedDoc.status === "uploaded" || selectedDoc.status === "failed") && (
              <Btn onClick={() => { processDoc(selectedDoc); setSelectedDoc(null); }} variant="success">⚡ Generate AI Summary</Btn>
            )}
            <Btn onClick={async () => {
              try { const r = await awsGet(`/documents/${selectedDoc.aws_document_id}/download-url`); window.open(r.download_url, "_blank"); }
              catch (e) { alert("Download failed: " + e.message); }
            }} variant="secondary">⬇ Download</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Summaries ────────────────────────────────────────────────────────────────
function Summaries({ summaries, onRefresh }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);

  const filtered = summaries.filter(s =>
    !search || `${s.patient_name || ""} ${s.document_title || ""} ${s.summary || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="AI Summaries" subtitle={`${summaries.length} summary${summaries.length !== 1 ? "ies" : "y"} generated`} />
      <SearchBar value={search} onChange={setSearch} placeholder="Search summaries…" onRefresh={onRefresh} />

      {summaries.length === 0 ? (
        <Empty icon="📋" message="No summaries yet — process a document to generate one" />
      ) : filtered.length === 0 ? (
        <Empty icon="🔍" message="No summaries match your search" />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(s => (
            <Card key={s.aws_summary_id} hover onClick={() => setSelected(s)} style={{ cursor: "pointer" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: C.purpleLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>📋</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: C.gray900, marginBottom: 2 }}>{s.document_title || "Summary"}</div>
                  {s.patient_name && <div style={{ fontSize: 12.5, color: C.blue, marginBottom: 6 }}>👤 {s.patient_name}</div>}
                  <div style={{ fontSize: 13, color: C.gray600, lineHeight: 1.55, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {s.summary || "No summary text"}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.gray400, flexShrink: 0 }}>{s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}</div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Modal title={selected.document_title || "Summary"} subtitle={selected.patient_name ? `Patient: ${selected.patient_name}` : undefined} onClose={() => setSelected(null)} width={800}>
          <div style={{ background: C.gray50, borderRadius: 10, padding: 20, maxHeight: 500, overflow: "auto" }}>
            <pre style={{ margin: 0, fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.7, whiteSpace: "pre-wrap", color: C.gray700 }}>{selected.summary || "No summary available"}</pre>
          </div>
          {selected.extracted_text && (
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: C.gray500, fontWeight: 500 }}>Show extracted text</summary>
              <div style={{ background: C.gray50, borderRadius: 8, padding: 14, marginTop: 8, maxHeight: 200, overflow: "auto", fontSize: 12, color: C.gray600, lineHeight: 1.6 }}>
                {selected.extracted_text}
              </div>
            </details>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── Notes Macros ─────────────────────────────────────────────────────────────
function NotesMacros() {
  const [macros, setMacros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", content: "", section: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { NotesMacro } = await import("../api/entities");
      const data = await NotesMacro.list();
      setMacros(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditing(null); setForm({ name: "", content: "", section: "" }); setShowModal(true); };
  const openEdit = (m) => { setEditing(m); setForm({ name: m.name || "", content: m.content || "", section: m.section || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.name.trim()) return alert("Name is required.");
    try {
      const { NotesMacro } = await import("../api/entities");
      if (editing) await NotesMacro.update(editing.id, form);
      else await NotesMacro.create(form);
      setShowModal(false); load();
    } catch (e) { alert(e.message); }
  };

  const del = async (m) => {
    if (!confirm(`Delete macro "${m.name}"?`)) return;
    try { const { NotesMacro } = await import("../api/entities"); await NotesMacro.delete(m.id); load(); } catch (e) { alert(e.message); }
  };

  const sections = [...new Set(macros.map(m => m.section).filter(Boolean))];
  const filtered = macros.filter(m => !search || `${m.name} ${m.section} ${m.content}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="Notes Macros" subtitle="Reusable text templates for clinical notes" action={<Btn onClick={openNew}>+ New Macro</Btn>} />
      <SearchBar value={search} onChange={setSearch} placeholder="Search macros…" onRefresh={load} />

      {loading ? <Spinner /> : filtered.length === 0 ? (
        <Empty icon="📝" message="No macros yet" action={<Btn onClick={openNew}>Create First Macro</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(m => (
            <Card key={m.id} hover style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: C.gray900 }}>{m.name}</span>
                  {m.section && <Badge text={m.section} color={C.purple} bg={C.purpleLight} />}
                </div>
                <div style={{ fontSize: 13, color: C.gray500, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{m.content}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn onClick={() => { navigator.clipboard?.writeText(m.content); }} variant="secondary" size="sm">Copy</Btn>
                <Btn onClick={() => openEdit(m)} variant="ghost" size="sm">Edit</Btn>
                <Btn onClick={() => del(m)} variant="ghost" size="sm" style={{ color: C.red }}>Del</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Macro" : "New Macro"} onClose={() => setShowModal(false)}>
          <Field label="Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} required placeholder="e.g. Normal Physical Exam" />
          <Field label="Section" value={form.section} onChange={v => setForm(p => ({ ...p, section: v }))} placeholder="e.g. Physical Exam, HPI, Assessment" />
          <Field label="Content" value={form.content} onChange={v => setForm(p => ({ ...p, content: v }))} as="textarea" rows={6} placeholder="Enter macro text…" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
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
  const [suggestions, setSuggestions] = useState([]);
  const [breaches, setBreaches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("suggestions");
  const [showBreachModal, setShowBreachModal] = useState(false);
  const [form, setForm] = useState({ event_type: "", severity: "low", description: "", affected_users: "", status: "open" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { Suggestion, BreachNotification } = await import("../api/entities");
      const [s, b] = await Promise.all([Suggestion.list(), BreachNotification.list()]);
      setSuggestions(s); setBreaches(b);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveBreachReport = async () => {
    if (!form.description.trim()) return alert("Description is required.");
    try {
      const { BreachNotification } = await import("../api/entities");
      await BreachNotification.create({ ...form, detected_date: new Date().toISOString(), notification_sent: false });
      setShowBreachModal(false); setForm({ event_type: "", severity: "low", description: "", affected_users: "", status: "open" }); load();
    } catch (e) { alert(e.message); }
  };

  const severityBadge = (s) => {
    const map = { low: { color: C.green, bg: C.greenLight }, medium: { color: C.amber, bg: C.amberLight }, high: { color: C.red, bg: C.redLight }, critical: { color: "#7f1d1d", bg: "#fee2e2" } };
    const v = map[s] || map.low;
    return <Badge text={s || "low"} color={v.color} bg={v.bg} />;
  };

  return (
    <div style={{ padding: 32 }}>
      <SectionHeader title="Admin" subtitle="Manage feedback and compliance reports" />

      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: C.gray100, borderRadius: 10, padding: 4, width: "fit-content" }}>
        {[["suggestions", "💡 Suggestions"], ["breaches", "🔒 Breach Log"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "7px 18px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13.5, fontWeight: 500,
            background: tab === id ? C.white : "transparent", color: tab === id ? C.navy : C.gray500,
            boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none"
          }}>{label}</button>
        ))}
      </div>

      {loading ? <Spinner /> : tab === "suggestions" ? (
        suggestions.length === 0 ? <Empty icon="💡" message="No suggestions submitted" /> : (
          <div style={{ display: "grid", gap: 10 }}>
            {suggestions.map(s => (
              <Card key={s.id}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: C.gray900, marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: C.gray500 }}>{s.description}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {s.priority && <Badge text={s.priority} color={C.amber} bg={C.amberLight} />}
                    {s.status && <Badge text={s.status} color={C.gray500} bg={C.gray100} />}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        <>
          <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowBreachModal(true)} variant="danger">+ Report Breach</Btn>
          </div>
          {breaches.length === 0 ? <Empty icon="🔒" message="No breach events logged — all clear" /> : (
            <div style={{ display: "grid", gap: 10 }}>
              {breaches.map(b => (
                <Card key={b.id}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "center" }}>
                        <span style={{ fontSize: 14.5, fontWeight: 600, color: C.gray900 }}>{b.event_type || "Breach Event"}</span>
                        {severityBadge(b.severity)}
                      </div>
                      <div style={{ fontSize: 13, color: C.gray500 }}>{b.description}</div>
                      {b.detected_date && <div style={{ fontSize: 11.5, color: C.gray400, marginTop: 4 }}>Detected: {new Date(b.detected_date).toLocaleString()}</div>}
                    </div>
                    <Badge text={b.status || "open"} color={b.status === "resolved" ? C.green : C.red} bg={b.status === "resolved" ? C.greenLight : C.redLight} />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {showBreachModal && (
        <Modal title="Report Breach Event" onClose={() => setShowBreachModal(false)}>
          <Field label="Event Type" value={form.event_type} onChange={v => setForm(p => ({ ...p, event_type: v }))} placeholder="e.g. Unauthorized Access, Data Leak" />
          <Field label="Severity" value={form.severity} onChange={v => setForm(p => ({ ...p, severity: v }))} as="select"
            options={["low", "medium", "high", "critical"].map(v => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />
          <Field label="Description" value={form.description} onChange={v => setForm(p => ({ ...p, description: v }))} as="textarea" rows={4} required />
          <Field label="Affected Users / Records" value={form.affected_users} onChange={v => setForm(p => ({ ...p, affected_users: v }))} placeholder="e.g. 0 (none identified)" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowBreachModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveBreachReport} variant="danger">Submit Report</Btn>
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

      const docResults = await Promise.all(
        pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(() => []))
      );
      const allDocs = docResults.flat();
      setDocuments(allDocs);
      // Summaries are embedded in processed documents
      const sums = allDocs.filter(d => d.aws_summary_id && d.summary).map(d => ({
        aws_summary_id: d.aws_summary_id,
        aws_patient_id: d.aws_patient_id,
        patient_name: d.patient_name,
        document_title: d.title || d.file_name,
        summary: d.summary,
        created_at: d.updated_at,
      }));
      setSummaries(sums);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const navigate = (p) => setPage(p);

  const renderPage = () => {
    if (loading && page === "dashboard") return <div style={{ padding: 32 }}><Spinner /></div>;
    switch (page) {
      case "dashboard": return <Dashboard onNav={navigate} patients={patients} documents={documents} summaries={summaries} />;
      case "patients": return <Patients patients={patients} documents={documents} onNav={navigate} onSelectPatient={setSelectedPatient} onRefresh={loadAll} />;
      case "patient-detail": return selectedPatient ? <PatientDetail patient={selectedPatient} documents={documents} summaries={summaries} onBack={() => navigate("patients")} onNav={navigate} /> : null;
      case "documents": return <Documents patients={patients} documents={documents} onRefresh={loadAll} />;
      case "summaries": return <Summaries summaries={summaries} onRefresh={loadAll} />;
      case "macros": return <NotesMacros />;
      case "admin": return <Admin />;
      default: return null;
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.gray50, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <Sidebar current={page} onNav={navigate} patientCount={patients.length} docCount={documents.length} summaryCount={summaries.length} />
      <div style={{ flex: 1, overflow: "auto" }}>{renderPage()}</div>
    </div>
  );
}
