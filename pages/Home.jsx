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
const awsGet  = (path)       => awsCall("GET",    path);
const awsPost = (path, body) => awsCall("POST",   path, body);
const awsPut  = (path, body) => awsCall("PUT",    path, body);
const awsDel  = (path)       => awsCall("DELETE", path);

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Sidebar({ page, onNav }) {
  const items = [
    { id: "dashboard",  icon: "🏠", label: "Dashboard"        },
    { id: "patients",   icon: "👥", label: "Patients"          },
    { id: "documents",  icon: "📁", label: "Documents"         },
    { id: "summaries",  icon: "📋", label: "Medical Summaries" },
    { id: "macros",     icon: "📝", label: "Notes Macros"      },
    { id: "admin",      icon: "⚙️", label: "Admin"             },
  ];
  return (
    <div style={{ width: 228, background: "#1a2e4a", color: "#fff", display: "flex", flexDirection: "column", minHeight: "100vh", flexShrink: 0 }}>
      <div style={{ padding: "24px 20px 18px" }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.3px" }}>ChartReview Pro</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>HIPAA Compliant · AWS</div>
      </div>
      <nav style={{ flex: 1, padding: "4px 10px" }}>
        {items.map(it => {
          const active = page === it.id;
          return (
            <button key={it.id} onClick={() => onNav(it.id)} style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "9px 10px", marginBottom: 2, border: "none", borderRadius: 8,
              cursor: "pointer", fontSize: 13.5, textAlign: "left",
              fontWeight: active ? 600 : 400,
              background: active ? "rgba(255,255,255,0.14)" : "transparent",
              color: active ? "#fff" : "rgba(255,255,255,0.62)",
              borderLeft: `3px solid ${active ? "#3b82f6" : "transparent"}`,
            }}>
              <span style={{ fontSize: 15 }}>{it.icon}</span> {it.label}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: "14px 20px", borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
        🔒 PHI on AWS · BAA Active
      </div>
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", disabled, style = {} }) {
  const v = {
    primary:   { background: "#1e3a5f", color: "#fff", border: "none" },
    secondary: { background: "#fff", color: "#374151", border: "1px solid #d1d5db" },
    danger:    { background: "#dc2626", color: "#fff", border: "none" },
    success:   { background: "#16a34a", color: "#fff", border: "none" },
    warning:   { background: "#d97706", color: "#fff", border: "none" },
    ghost:     { background: "transparent", color: "#6b7280", border: "none" },
  };
  const sz = {
    sm: { padding: "4px 10px", fontSize: 12 },
    md: { padding: "7px 14px", fontSize: 13.5 },
    lg: { padding: "10px 20px", fontSize: 15 },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      borderRadius: 7, cursor: disabled ? "not-allowed" : "pointer",
      fontWeight: 500, opacity: disabled ? 0.55 : 1,
      ...v[variant], ...sz[size], ...style,
    }}>{children}</button>
  );
}

function Card({ children, style = {}, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
      padding: "16px 18px", cursor: onClick ? "pointer" : undefined, ...style,
    }}>{children}</div>
  );
}

function Modal({ title, subtitle, onClose, children, width = 580 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.38)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 14, width, maxWidth: "96vw", maxHeight: "92vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.22)" }}>
        <div style={{ padding: "22px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: "#f3f4f6", border: "none", width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 15, color: "#6b7280" }}>✕</button>
        </div>
        <div style={{ padding: "18px 24px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function Label({ children, required }) {
  return <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#374151", marginBottom: 5 }}>{children}{required && <span style={{ color: "#dc2626" }}> *</span>}</label>;
}
const inputStyle = { width: "100%", padding: "8px 11px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 13.5, boxSizing: "border-box", outline: "none", color: "#111827" };
function FInput({ label, value, onChange, placeholder, required, type = "text" }) {
  return <div style={{ marginBottom: 13 }}><Label required={required}>{label}</Label><input type={type} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></div>;
}
function FTextarea({ label, value, onChange, rows = 4, placeholder }) {
  return <div style={{ marginBottom: 13 }}><Label>{label}</Label><textarea style={{ ...inputStyle, resize: "vertical" }} rows={rows} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></div>;
}
function FSelect({ label, value, onChange, options }) {
  return <div style={{ marginBottom: 13 }}><Label>{label}</Label><select style={{ ...inputStyle, background: "#fff" }} value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}</select></div>;
}

function Badge({ text, color = "#6b7280", bg = "#f3f4f6" }) {
  return <span style={{ padding: "2px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, color, background: bg, whiteSpace: "nowrap" }}>{text}</span>;
}

function StatusBadge({ status }) {
  const m = {
    completed:  { text: "Completed ✓",  color: "#16a34a", bg: "#dcfce7" },
    processed:  { text: "Processed ✓",  color: "#16a34a", bg: "#dcfce7" },
    processing: { text: "Processing…",  color: "#d97706", bg: "#fef3c7" },
    uploaded:   { text: "Uploaded",     color: "#6b7280", bg: "#f3f4f6" },
    pending:    { text: "Pending",      color: "#d97706", bg: "#fef3c7" },
    failed:     { text: "Failed",       color: "#dc2626", bg: "#fee2e2" },
  };
  const v = m[status] || m.uploaded;
  return <Badge text={v.text} color={v.color} bg={v.bg} />;
}

function Spinner({ text = "Loading…" }) {
  return <div style={{ padding: 60, textAlign: "center", color: "#9ca3af", fontSize: 14 }}>{text}</div>;
}

function Empty({ icon = "📭", title, sub, action }) {
  return (
    <div style={{ textAlign: "center", padding: "52px 20px", color: "#9ca3af" }}>
      <div style={{ fontSize: 42, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, marginBottom: 16 }}>{sub}</div>}
      {action}
    </div>
  );
}

function PageHeader({ title, subtitle, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>{title}</h1>
        {subtitle && <p style={{ margin: "3px 0 0", fontSize: 13.5, color: "#6b7280" }}>{subtitle}</p>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>{children}</div>
    </div>
  );
}

const CATEGORIES = ["Medical Records", "Imaging", "Lab Results", "Operative Notes", "Discharge Summary", "Consultation", "Physical Therapy", "Mental Health", "Legal", "Other"];

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ onNav, patients, documents, summaries }) {
  const processed  = documents.filter(d => ["completed","processed"].includes(d.status)).length;
  const withDupes  = documents.filter(d => d.has_duplicate_pages).length;
  const recentDocs = [...documents].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,5);

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Dashboard" subtitle="Welcome to ChartReview Pro" />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 26 }}>
        {[
          { icon:"👥", label:"Patients",         value: patients.length,  color:"#3b82f6", page:"patients"  },
          { icon:"📁", label:"Documents",        value: documents.length, color:"#10b981", page:"documents" },
          { icon:"✅", label:"Processed",        value: processed,        color:"#7c3aed", page:"documents" },
          { icon:"📋", label:"Summaries",        value: summaries.length, color:"#f59e0b", page:"summaries" },
        ].map(sc => (
          <Card key={sc.label} onClick={() => onNav(sc.page)} style={{ display:"flex", alignItems:"center", gap:14, cursor:"pointer" }}>
            <div style={{ width:48, height:48, borderRadius:12, background: sc.color+"18", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>{sc.icon}</div>
            <div>
              <div style={{ fontSize:26, fontWeight:800, color:"#111827" }}>{sc.value}</div>
              <div style={{ fontSize:12, color:"#6b7280" }}>{sc.label}</div>
            </div>
          </Card>
        ))}
      </div>

      {withDupes > 0 && (
        <div onClick={() => onNav("documents")} style={{ background:"#fef3c7", border:"1px solid #fcd34d", borderRadius:9, padding:"12px 16px", marginBottom:18, cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20 }}>⚠️</span>
          <span style={{ fontSize:13.5, color:"#92400e", fontWeight:500 }}>{withDupes} document{withDupes!==1?"s":""} ha{withDupes!==1?"ve":"s"} duplicate pages detected — click to review</span>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1.3fr 1fr", gap:18 }}>
        <Card>
          <div style={{ fontWeight:700, fontSize:14, color:"#1e3a5f", marginBottom:14, display:"flex", justifyContent:"space-between" }}>
            Recent Documents
            <span onClick={() => onNav("documents")} style={{ fontSize:12, fontWeight:400, color:"#3b82f6", cursor:"pointer" }}>View all →</span>
          </div>
          {recentDocs.length === 0
            ? <div style={{ color:"#9ca3af", fontSize:13, textAlign:"center", padding:20 }}>No documents yet</div>
            : recentDocs.map(d => (
              <div key={d.aws_document_id} style={{ display:"flex", gap:10, alignItems:"center", padding:"8px 0", borderBottom:"1px solid #f3f4f6" }}>
                <span style={{ fontSize:18 }}>📄</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:"#111827", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.title||d.file_name}</div>
                  <div style={{ fontSize:11.5, color:"#9ca3af" }}>{d.patient_name||"—"} · {d.category||"—"}</div>
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))
          }
        </Card>

        <Card>
          <div style={{ fontWeight:700, fontSize:14, color:"#1e3a5f", marginBottom:14, display:"flex", justifyContent:"space-between" }}>
            Patients
            <span onClick={() => onNav("patients")} style={{ fontSize:12, fontWeight:400, color:"#3b82f6", cursor:"pointer" }}>View all →</span>
          </div>
          {patients.length === 0
            ? <div style={{ color:"#9ca3af", fontSize:13, textAlign:"center", padding:20 }}>No patients yet</div>
            : patients.slice(0,7).map(p => (
              <div key={p.aws_patient_id} style={{ display:"flex", gap:10, alignItems:"center", padding:"7px 0", borderBottom:"1px solid #f3f4f6" }}>
                <div style={{ width:30, height:30, borderRadius:"50%", background:"#eff6ff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#3b82f6" }}>
                  {(p.patient_name||"?")[0].toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:"#111827", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.patient_name}</div>
                  {p.case_number && <div style={{ fontSize:11, color:"#9ca3af" }}>Case: {p.case_number}</div>}
                </div>
              </div>
            ))
          }
        </Card>
      </div>
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────
function Documents({ patients, documents, onRefresh }) {
  const [search,       setSearch]       = useState("");
  const [catFilter,    setCatFilter]    = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showUpload,   setShowUpload]   = useState(false);
  const [viewDoc,      setViewDoc]      = useState(null);
  const [processing,   setProcessing]   = useState({});

  // Multi-file upload state
  const [fileQueue,  setFileQueue]  = useState([]);  // [{file, patient_name, case_number, title, category, status, error}]
  const [uploading,  setUploading]  = useState(false);
  const [uploadForm, setUploadForm] = useState({ patient_name: "", case_number: "", category: "Medical Records" });
  const fileInputRef = useRef();

  const filtered = documents.filter(d => {
    const q = search.toLowerCase();
    if (search && !`${d.patient_name||""} ${d.title||""} ${d.file_name||""} ${d.case_number||""}`.toLowerCase().includes(q)) return false;
    if (catFilter !== "all" && (d.category||"other").toLowerCase().replace(/\s+/g,"_") !== catFilter) return false;
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    return true;
  });

  // Add files to queue
  const addFiles = (newFiles) => {
    const items = Array.from(newFiles).map(file => ({
      id: Math.random().toString(36).slice(2),
      file,
      patient_name: uploadForm.patient_name,
      case_number:  uploadForm.case_number,
      title:        "",
      category:     uploadForm.category,
      status:       "queued",  // queued | uploading | done | error
      error:        null,
      progress:     0,
    }));
    setFileQueue(q => [...q, ...items]);
  };

  const removeFromQueue = (id) => setFileQueue(q => q.filter(i => i.id !== id));

  const updateQueueItem = (id, updates) => setFileQueue(q => q.map(i => i.id === id ? { ...i, ...updates } : i));

  // Upload all queued files sequentially
  const uploadAll = async () => {
    if (!uploadForm.patient_name.trim()) return alert("Patient name is required.");
    if (fileQueue.length === 0) return alert("Add at least one file.");
    setUploading(true);
    for (const item of fileQueue) {
      if (item.status === "done") continue;
      updateQueueItem(item.id, { status: "uploading", error: null });
      try {
        // Create patient
        const pRes = await awsPost("/patients", {
          patient_name: item.patient_name || uploadForm.patient_name,
          case_number:  item.case_number  || uploadForm.case_number || undefined,
        });
        const awsPatientId = pRes?.aws_patient_id;

        // Get presigned URL
        const uploadData = await awsPost("/documents/upload-url", {
          aws_patient_id: awsPatientId,
          patient_name:   item.patient_name || uploadForm.patient_name,
          file_name:      item.file.name,
          content_type:   item.file.type || "application/octet-stream",
          title:          item.title || item.file.name,
          category:       item.category,
          case_number:    item.case_number || uploadForm.case_number || undefined,
        });
        if (!uploadData.upload_url) throw new Error("No upload URL returned");

        // Upload to S3
        const s3 = await fetch(uploadData.upload_url, {
          method: "PUT", body: item.file,
          headers: { "Content-Type": item.file.type || "application/octet-stream" },
        });
        if (!s3.ok) throw new Error("S3 upload failed: " + s3.status);

        // Trigger processing (non-fatal)
        await awsPost(`/documents/${uploadData.aws_document_id}/process`, {}).catch(() => {});

        updateQueueItem(item.id, { status: "done" });
      } catch (e) {
        updateQueueItem(item.id, { status: "error", error: e.message });
      }
    }
    setUploading(false);
    onRefresh();
  };

  const closeUpload = () => {
    setShowUpload(false);
    setFileQueue([]);
    setUploadForm({ patient_name: "", case_number: "", category: "Medical Records" });
  };

  const processDoc = async (doc) => {
    setProcessing(p => ({ ...p, [doc.aws_document_id]: true }));
    try {
      const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      const preview = res.summary ? `\n\n${res.summary.substring(0, 500)}…` : "";
      alert("✅ Processing complete!" + preview);
      onRefresh();
    } catch (e) { alert("Processing failed: " + e.message); }
    setProcessing(p => ({ ...p, [doc.aws_document_id]: false }));
  };

  const deleteDoc = async (doc) => {
    if (!confirm(`Delete "${doc.title || doc.file_name}"? This cannot be undone.`)) return;
    try { await awsDel(`/documents/${doc.aws_document_id}`); onRefresh(); }
    catch (e) { alert(e.message); }
  };

  const allDone = fileQueue.length > 0 && fileQueue.every(i => i.status === "done");

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Documents" subtitle={`${documents.length} document${documents.length!==1?"s":""}`}>
        <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
        <Btn onClick={() => setShowUpload(true)}>+ Upload Documents</Btn>
      </PageHeader>

      {/* Filters */}
      <Card style={{ marginBottom: 14, padding: "12px 14px" }}>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search patient, title, case…"
            style={{ ...inputStyle, flex:1, minWidth:180 }} />
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={{ ...inputStyle, width:"auto", minWidth:140 }}>
            <option value="all">All Categories</option>
            <option value="medical">Medical</option>
            <option value="legal">Legal</option>
            <option value="imaging">Imaging</option>
            <option value="other">Other</option>
          </select>
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} style={{ ...inputStyle, width:"auto", minWidth:130 }}>
            <option value="all">All Status</option>
            <option value="uploaded">Uploaded</option>
            <option value="processing">Processing</option>
            <option value="processed">Processed</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
          {(search||catFilter!=="all"||statusFilter!=="all") && <Btn onClick={()=>{setSearch("");setCatFilter("all");setStatusFilter("all");}} variant="ghost" size="sm">Clear</Btn>}
        </div>
      </Card>

      {/* Document List */}
      {documents.length === 0 ? (
        <Empty icon="📁" title="No documents yet" sub="Upload medical records to get started" action={<Btn onClick={()=>setShowUpload(true)}>Upload Documents</Btn>} />
      ) : filtered.length === 0 ? (
        <Empty icon="🔍" title="No documents match your filters" />
      ) : (
        <div style={{ display:"grid", gap:8 }}>
          {filtered.map(d => (
            <Card key={d.aws_document_id} style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ width:42, height:42, borderRadius:9, background:"#eff6ff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>
                {d.file_type?.includes("image") ? "🖼️" : "📄"}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                  <span style={{ fontSize:14, fontWeight:600, color:"#111827", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.title||d.file_name}</span>
                  {d.has_duplicate_pages && <Badge text="⚠ Duplicate Pages" color="#92400e" bg="#fef3c7" />}
                  {d.is_duplicate && <Badge text="Duplicate" color="#dc2626" bg="#fee2e2" />}
                </div>
                <div style={{ fontSize:12, color:"#6b7280", display:"flex", gap:12, flexWrap:"wrap" }}>
                  {d.patient_name  && <span>👤 {d.patient_name}</span>}
                  {d.case_number   && <span>📁 {d.case_number}</span>}
                  {d.provider_name && <span>🏥 {d.provider_name}</span>}
                  {d.page_count    && <span>📃 {d.page_count}pp</span>}
                  {d.document_date && <span>📅 {d.document_date}</span>}
                  {d.category      && <Badge text={d.category} color="#1d4ed8" bg="#dbeafe" />}
                </div>
              </div>
              <div style={{ display:"flex", gap:6, alignItems:"center", flexShrink:0 }}>
                <StatusBadge status={d.status} />
                {!["completed","processed"].includes(d.status) && (
                  <Btn onClick={()=>processDoc(d)} variant="secondary" size="sm" disabled={processing[d.aws_document_id]}>
                    {processing[d.aws_document_id] ? "…" : "⚡ Process"}
                  </Btn>
                )}
                <Btn onClick={()=>setViewDoc(d)} variant="secondary" size="sm">View</Btn>
                <Btn onClick={()=>deleteDoc(d)} variant="ghost" size="sm" style={{ color:"#dc2626" }}>✕</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Multi-file Upload Modal ── */}
      {showUpload && (
        <Modal title="Upload Documents" subtitle="Select one or more files — all will be processed by AI" onClose={closeUpload} width={680}>
          {/* Shared patient info */}
          <div style={{ background:"#f9fafb", borderRadius:9, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#374151", marginBottom:10, textTransform:"uppercase", letterSpacing:"0.4px" }}>Patient Info (applies to all files)</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
              <FInput label="Patient Name" required value={uploadForm.patient_name} onChange={v=>setUploadForm(f=>({...f,patient_name:v}))} placeholder="e.g. Jane Smith" />
              <FInput label="Case Number" value={uploadForm.case_number} onChange={v=>setUploadForm(f=>({...f,case_number:v}))} placeholder="e.g. 4A2505HTQH00001" />
            </div>
            <FSelect label="Default Category" value={uploadForm.category} onChange={v=>setUploadForm(f=>({...f,category:v}))} options={CATEGORIES} />
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor="#3b82f6";}}
            onDragLeave={e=>{e.currentTarget.style.borderColor="#d1d5db";}}
            onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor="#d1d5db";addFiles(e.dataTransfer.files);}}
            onClick={()=>fileInputRef.current.click()}
            style={{ border:"2px dashed #d1d5db", borderRadius:10, padding:"28px 20px", textAlign:"center", cursor:"pointer", marginBottom:14, transition:"border-color 0.15s" }}
          >
            <div style={{ fontSize:32, marginBottom:8 }}>📂</div>
            <div style={{ fontSize:14, fontWeight:500, color:"#374151" }}>Drop files here or click to browse</div>
            <div style={{ fontSize:12, color:"#9ca3af", marginTop:4 }}>PDF, JPG, PNG, TIFF — multiple files supported</div>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tiff" style={{ display:"none" }} onChange={e=>addFiles(e.target.files)} />
          </div>

          {/* Queue */}
          {fileQueue.length > 0 && (
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, fontWeight:700, color:"#374151", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.4px" }}>
                File Queue ({fileQueue.length} file{fileQueue.length!==1?"s":""})
              </div>
              <div style={{ display:"grid", gap:6, maxHeight:280, overflow:"auto" }}>
                {fileQueue.map(item => (
                  <div key={item.id} style={{
                    display:"flex", alignItems:"center", gap:10, padding:"10px 12px",
                    borderRadius:8, border:"1px solid #e5e7eb",
                    background: item.status==="done"?"#f0fdf4" : item.status==="error"?"#fef2f2" : "#fff",
                  }}>
                    <span style={{ fontSize:18 }}>📄</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:500, color:"#111827", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.file.name}</div>
                      <div style={{ fontSize:11, color:"#9ca3af" }}>{(item.file.size/1024/1024).toFixed(2)} MB · {item.category}</div>
                      {item.error && <div style={{ fontSize:11, color:"#dc2626", marginTop:2 }}>✗ {item.error}</div>}
                    </div>
                    <div style={{ flexShrink:0 }}>
                      {item.status==="queued"    && <Badge text="Queued"     color="#6b7280" bg="#f3f4f6" />}
                      {item.status==="uploading" && <Badge text="Uploading…" color="#d97706" bg="#fef3c7" />}
                      {item.status==="done"      && <Badge text="✓ Done"     color="#16a34a" bg="#dcfce7" />}
                      {item.status==="error"     && <Badge text="Failed"     color="#dc2626" bg="#fee2e2" />}
                    </div>
                    {item.status !== "uploading" && (
                      <button onClick={()=>removeFromQueue(item.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#9ca3af", fontSize:14 }}>✕</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontSize:12, color:"#9ca3af" }}>
              {fileQueue.filter(i=>i.status==="done").length}/{fileQueue.length} uploaded
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn onClick={closeUpload} variant="secondary">{allDone ? "Close" : "Cancel"}</Btn>
              {!allDone && (
                <Btn onClick={uploadAll} disabled={uploading||fileQueue.length===0}>
                  {uploading ? "Uploading…" : `Upload ${fileQueue.length} File${fileQueue.length!==1?"s":""}`}
                </Btn>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ── View Document Modal ── */}
      {viewDoc && (
        <Modal title={viewDoc.title||viewDoc.file_name} subtitle={`Patient: ${viewDoc.patient_name||"—"} · Case: ${viewDoc.case_number||"—"}`} onClose={()=>setViewDoc(null)} width={700}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:16 }}>
            {[
              ["Status",   <StatusBadge status={viewDoc.status} />],
              ["Category", viewDoc.category||"—"],
              ["Pages",    viewDoc.page_count||"—"],
              ["Date",     viewDoc.document_date||"—"],
              ["Provider", viewDoc.provider_name||"—"],
              ["Size",     viewDoc.file_size ? `${(viewDoc.file_size/1024/1024).toFixed(2)} MB` : "—"],
            ].map(([lbl,val])=>(
              <div key={lbl} style={{ background:"#f9fafb", borderRadius:7, padding:"9px 12px" }}>
                <div style={{ fontSize:10.5, color:"#9ca3af", fontWeight:700, marginBottom:2, textTransform:"uppercase" }}>{lbl}</div>
                <div style={{ fontSize:13, fontWeight:500, color:"#374151" }}>{val}</div>
              </div>
            ))}
          </div>

          {viewDoc.has_duplicate_pages && viewDoc.duplicate_pages?.length > 0 && (
            <div style={{ background:"#fef3c7", border:"1px solid #fcd34d", borderRadius:8, padding:"12px 14px", marginBottom:14 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"#92400e", marginBottom:6 }}>⚠ Duplicate Pages Detected</div>
              {viewDoc.duplicate_pages.slice(0,4).map((dp,i)=>(
                <div key={i} style={{ fontSize:12, color:"#78350f", marginBottom:3 }}>
                  Pages {(dp.page_numbers||[]).join(", ")}: {dp.similarity}
                </div>
              ))}
              {viewDoc.duplicate_pages.length > 4 && <div style={{ fontSize:12, color:"#92400e" }}>+{viewDoc.duplicate_pages.length-4} more…</div>}
            </div>
          )}

          {viewDoc.notes && (
            <div style={{ background:"#f9fafb", borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13, color:"#4b5563", lineHeight:1.6 }}>
              {viewDoc.notes}
            </div>
          )}

          <div style={{ display:"flex", gap:8 }}>
            {!["completed","processed"].includes(viewDoc.status) && (
              <Btn onClick={()=>{processDoc(viewDoc);setViewDoc(null);}} variant="success">⚡ Generate AI Summary</Btn>
            )}
            <Btn onClick={async()=>{
              try { const r = await awsGet(`/documents/${viewDoc.aws_document_id}/download-url`); window.open(r.download_url,"_blank"); }
              catch(e){ alert("Download failed: "+e.message); }
            }} variant="secondary">⬇ Download PDF</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Medical Summaries ────────────────────────────────────────────────────────
function Summaries({ summaries, patients, onRefresh }) {
  const [selected,  setSelected]  = useState(null);
  const [search,    setSearch]    = useState("");
  const [creating,  setCreating]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [form,      setForm]      = useState({ patient_id:"", header_note:"", ime_note:"", chart_review_note:"", discussion_note:"", physical_examination_note:"", footer_note:"" });

  const filtered = summaries.filter(s =>
    !search || `${s.patient_name||""} ${s.case_number||""}`.toLowerCase().includes(search.toLowerCase())
  );

  const saveSummary = async () => {
    if (!form.patient_id) return alert("Select a patient.");
    setSaving(true);
    try {
      await awsPost("/summaries", form);
      setCreating(false);
      setForm({ patient_id:"", header_note:"", ime_note:"", chart_review_note:"", discussion_note:"", physical_examination_note:"", footer_note:"" });
      onRefresh();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const deleteSummary = async (id) => {
    if (!confirm("Delete this summary?")) return;
    try { await awsDel(`/summaries/${id}`); onRefresh(); } catch(e) { alert(e.message); }
  };

  const progressionColor = (p) => {
    if (p === "improved") return { color:"#16a34a", bg:"#dcfce7" };
    if (p === "worse")    return { color:"#dc2626", bg:"#fee2e2" };
    return                       { color:"#6b7280", bg:"#f3f4f6" };
  };

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Medical Summaries" subtitle={`${summaries.length} summar${summaries.length!==1?"ies":"y"}`}>
        <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
        <Btn onClick={()=>setCreating(true)}>+ New Summary</Btn>
      </PageHeader>

      <Card style={{ marginBottom:14, padding:"12px 14px" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by patient or case…"
          style={{ ...inputStyle, border:"none", outline:"none", background:"transparent" }} />
      </Card>

      {summaries.length === 0 ? (
        <Empty icon="📋" title="No summaries yet" sub="Create a summary to document a patient's visit history" action={<Btn onClick={()=>setCreating(true)}>Create Summary</Btn>} />
      ) : filtered.length === 0 ? (
        <Empty icon="🔍" title="No summaries match your search" />
      ) : (
        <div style={{ display:"grid", gap:8 }}>
          {filtered.map(sum => (
            <Card key={sum.aws_summary_id} style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
              <div style={{ width:42, height:42, borderRadius:9, background:"#ede9fe", display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>📋</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:600, color:"#111827", marginBottom:3 }}>{sum.patient_name||"Unknown Patient"}</div>
                <div style={{ fontSize:12, color:"#6b7280", marginBottom:5 }}>
                  {sum.case_number && <span style={{ marginRight:10 }}>📁 {sum.case_number}</span>}
                  {sum.visits?.length > 0 && <span>{sum.visits.length} visit{sum.visits.length!==1?"s":""} documented</span>}
                </div>
                {sum.header_note && (
                  <div style={{ fontSize:13, color:"#4b5563", lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>
                    {sum.header_note}
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                <Btn onClick={()=>setSelected(sum)} variant="secondary" size="sm">View</Btn>
                <Btn onClick={()=>deleteSummary(sum.aws_summary_id)} variant="ghost" size="sm" style={{ color:"#dc2626" }}>✕</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Full Summary Viewer */}
      {selected && (
        <Modal title={`Summary — ${selected.patient_name||"Patient"}`} subtitle={selected.case_number?`Case: ${selected.case_number}`:undefined} onClose={()=>setSelected(null)} width={860}>
          {selected.header_note && (
            <div style={{ background:"#f9fafb", borderRadius:8, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:"#9ca3af", marginBottom:5, textTransform:"uppercase" }}>Header Note</div>
              <div style={{ fontSize:13.5, color:"#374151", lineHeight:1.7, whiteSpace:"pre-line" }}>{selected.header_note}</div>
            </div>
          )}

          {selected.visits?.length > 0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:13, fontWeight:700, color:"#111827", marginBottom:10 }}>
                Visit Timeline — {selected.visits.length} Visit{selected.visits.length!==1?"s":""}
              </div>
              <div style={{ display:"grid", gap:10, maxHeight:500, overflow:"auto", paddingRight:4 }}>
                {selected.visits.map((v, i) => {
                  const pc = progressionColor(v.symptom_progression);
                  return (
                    <div key={i} style={{ background:"#f9fafb", borderRadius:9, padding:14, borderLeft:"3px solid #3b82f6" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                        <span style={{ fontSize:13.5, fontWeight:700, color:"#111827" }}>{v.visit_date}</span>
                        <div style={{ display:"flex", gap:6 }}>
                          {(v.icd10_codes||[]).slice(0,2).map(c=>(
                            <span key={c} style={{ fontSize:11, background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:4, padding:"1px 6px", color:"#374151" }}>{c}</span>
                          ))}
                          {v.symptom_progression && v.symptom_progression !== "not_documented" && (
                            <Badge text={v.symptom_progression.replace(/_/g," ")} color={pc.color} bg={pc.bg} />
                          )}
                          {v.pain_scale && v.pain_scale !== "not_documented" && (
                            <Badge text={`Pain: ${v.pain_scale}`} color="#6b7280" bg="#f3f4f6" />
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize:12, color:"#6b7280", marginBottom:8 }}>
                        {v.rendering_provider && <span style={{ marginRight:12 }}>👨‍⚕️ {v.rendering_provider}</span>}
                        {v.practice_setting   && <span>🏥 {v.practice_setting}</span>}
                      </div>
                      {v.hpi_summary && (
                        <div style={{ fontSize:13, color:"#374151", marginBottom:6, lineHeight:1.6 }}>
                          <strong>HPI:</strong> {v.hpi_summary}
                        </div>
                      )}
                      {v.impression_diagnosis && (
                        <div style={{ fontSize:13, color:"#374151", marginBottom:6 }}>
                          <strong>Impression:</strong> {v.impression_diagnosis}
                        </div>
                      )}
                      {v.physical_exam_findings && (
                        <details style={{ marginTop:4 }}>
                          <summary style={{ fontSize:12, color:"#6b7280", cursor:"pointer", fontWeight:500 }}>Physical Exam ▸</summary>
                          <div style={{ fontSize:12.5, color:"#4b5563", lineHeight:1.6, marginTop:5, whiteSpace:"pre-line" }}>{v.physical_exam_findings}</div>
                        </details>
                      )}
                      {v.imaging_findings && (
                        <details style={{ marginTop:4 }}>
                          <summary style={{ fontSize:12, color:"#6b7280", cursor:"pointer", fontWeight:500 }}>Imaging ▸</summary>
                          <div style={{ fontSize:12.5, color:"#4b5563", lineHeight:1.6, marginTop:5 }}>{v.imaging_findings}</div>
                        </details>
                      )}
                      {v.treatment_plan && (
                        <details style={{ marginTop:4 }}>
                          <summary style={{ fontSize:12, color:"#6b7280", cursor:"pointer", fontWeight:500 }}>Treatment Plan ▸</summary>
                          <div style={{ fontSize:12.5, color:"#4b5563", lineHeight:1.6, marginTop:5 }}>{v.treatment_plan}</div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selected.ime_note && (
            <div style={{ background:"#f9fafb", borderRadius:8, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:"#9ca3af", marginBottom:5, textTransform:"uppercase" }}>IME Note</div>
              <div style={{ fontSize:13.5, color:"#374151", lineHeight:1.7, whiteSpace:"pre-line" }}>{selected.ime_note}</div>
            </div>
          )}
          {selected.discussion_note && (
            <div style={{ background:"#f9fafb", borderRadius:8, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:"#9ca3af", marginBottom:5, textTransform:"uppercase" }}>Discussion</div>
              <div style={{ fontSize:13.5, color:"#374151", lineHeight:1.7, whiteSpace:"pre-line" }}>{selected.discussion_note}</div>
            </div>
          )}
          {selected.footer_note && (
            <div style={{ background:"#f9fafb", borderRadius:8, padding:14 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:"#9ca3af", marginBottom:5, textTransform:"uppercase" }}>Footer Note</div>
              <div style={{ fontSize:13.5, color:"#374151", lineHeight:1.7, whiteSpace:"pre-line" }}>{selected.footer_note}</div>
            </div>
          )}
        </Modal>
      )}

      {/* Create Modal */}
      {creating && (
        <Modal title="New Medical Summary" onClose={()=>setCreating(false)} width={640}>
          <FSelect label="Patient" value={form.patient_id} onChange={v=>setForm(f=>({...f,patient_id:v}))}
            options={[{value:"",label:"Select patient…"},...patients.map(p=>({value:p.aws_patient_id,label:p.patient_name}))]} />
          <FTextarea label="Header Note" value={form.header_note} onChange={v=>setForm(f=>({...f,header_note:v}))} rows={4} placeholder="Introductory narrative…" />
          <FTextarea label="IME Note" value={form.ime_note} onChange={v=>setForm(f=>({...f,ime_note:v}))} rows={4} placeholder="Independent Medical Exam notes…" />
          <FTextarea label="Discussion" value={form.discussion_note} onChange={v=>setForm(f=>({...f,discussion_note:v}))} rows={3} />
          <FTextarea label="Footer Note" value={form.footer_note} onChange={v=>setForm(f=>({...f,footer_note:v}))} rows={3} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setCreating(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveSummary} disabled={saving}>{saving?"Saving…":"Create Summary"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patients ─────────────────────────────────────────────────────────────────
function Patients({ patients, documents, onRefresh, onSelectPatient, onNav }) {
  const [search,    setSearch]    = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [form,      setForm]      = useState({ patient_name:"", date_of_birth:"", case_number:"", notes:"" });

  const filtered = patients.filter(p =>
    !search || `${p.patient_name||""} ${p.case_number||""}`.toLowerCase().includes(search.toLowerCase())
  );
  const openNew  = () => { setEditing(null); setForm({ patient_name:"", date_of_birth:"", case_number:"", notes:"" }); setShowModal(true); };
  const openEdit = p  => { setEditing(p);    setForm({ patient_name:p.patient_name||"", date_of_birth:p.date_of_birth||"", case_number:p.case_number||"", notes:p.notes||"" }); setShowModal(true); };

  const save = async () => {
    if (!form.patient_name.trim()) return alert("Patient name required.");
    setSaving(true);
    try {
      if (editing) await awsPut(`/patients/${editing.aws_patient_id}`, form);
      else         await awsPost("/patients", form);
      setShowModal(false); onRefresh();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const del = async p => {
    if (!confirm(`Delete "${p.patient_name}"? Cannot be undone.`)) return;
    try { await awsDel(`/patients/${p.aws_patient_id}`); onRefresh(); } catch(e) { alert(e.message); }
  };

  const docCount = id => documents.filter(d => d.aws_patient_id === id).length;

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Patients" subtitle={`${patients.length} patient${patients.length!==1?"s":""} on file`}>
        <Btn onClick={onRefresh} variant="secondary">↻ Refresh</Btn>
        <Btn onClick={openNew}>+ New Patient</Btn>
      </PageHeader>

      <div style={{ marginBottom:14 }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name or case number…"
          style={{ ...inputStyle, maxWidth:360 }} />
      </div>

      {patients.length === 0 ? (
        <Empty icon="👥" title="No patients yet" action={<Btn onClick={openNew}>Add First Patient</Btn>} />
      ) : (
        <div style={{ display:"grid", gap:8 }}>
          {filtered.map(p => (
            <Card key={p.aws_patient_id} style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ width:42, height:42, borderRadius:"50%", background:"#eff6ff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:700, color:"#3b82f6", flexShrink:0 }}>
                {(p.patient_name||"?")[0].toUpperCase()}
              </div>
              <div style={{ flex:1, minWidth:0, cursor:"pointer" }} onClick={()=>{ onSelectPatient(p); onNav("patient-detail"); }}>
                <div style={{ fontSize:14, fontWeight:600, color:"#111827" }}>{p.patient_name}</div>
                <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>
                  {p.date_of_birth && <span style={{ marginRight:10 }}>DOB: {p.date_of_birth}</span>}
                  {p.case_number   && <span style={{ marginRight:10 }}>Case: {p.case_number}</span>}
                  <span>📄 {docCount(p.aws_patient_id)} doc{docCount(p.aws_patient_id)!==1?"s":""}</span>
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <Btn onClick={()=>{ onSelectPatient(p); onNav("patient-detail"); }} variant="secondary" size="sm">View</Btn>
                <Btn onClick={()=>openEdit(p)} variant="secondary" size="sm">Edit</Btn>
                <Btn onClick={()=>del(p)}      variant="danger"    size="sm">Delete</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Patient" : "New Patient"} onClose={()=>setShowModal(false)}>
          <FInput label="Full Name" required value={form.patient_name} onChange={v=>setForm(f=>({...f,patient_name:v}))} placeholder="e.g. Silvia Guzman" />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
            <FInput label="Date of Birth" type="date" value={form.date_of_birth} onChange={v=>setForm(f=>({...f,date_of_birth:v}))} />
            <FInput label="Case Number" value={form.case_number} onChange={v=>setForm(f=>({...f,case_number:v}))} />
          </div>
          <FTextarea label="Notes" value={form.notes} onChange={v=>setForm(f=>({...f,notes:v}))} rows={3} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving?"Saving…": editing?"Update":"Create"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patient Detail ───────────────────────────────────────────────────────────
function PatientDetail({ patient, documents, summaries, onBack, onNav }) {
  const docs = documents.filter(d => d.aws_patient_id === patient.aws_patient_id);
  const sums = summaries.filter(s => s.aws_patient_id === patient.aws_patient_id);
  const [tab, setTab] = useState("docs");

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
        <Btn onClick={onBack} variant="secondary" size="sm">← Back</Btn>
        <div style={{ width:40, height:40, borderRadius:"50%", background:"#eff6ff", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, color:"#3b82f6" }}>
          {(patient.patient_name||"?")[0].toUpperCase()}
        </div>
        <div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:700, color:"#111827" }}>{patient.patient_name}</h1>
          <p style={{ margin:"2px 0 0", fontSize:13, color:"#6b7280" }}>
            {[patient.date_of_birth && `DOB: ${patient.date_of_birth}`, patient.case_number && `Case: ${patient.case_number}`].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:20 }}>
        {[["📄","Documents",docs.length],["📋","Summaries",sums.length],["✅","Processed",docs.filter(d=>["completed","processed"].includes(d.status)).length]].map(([ic,lb,v])=>(
          <Card key={lb}><div style={{ fontSize:11, color:"#9ca3af", fontWeight:600, marginBottom:2 }}>{ic} {lb.toUpperCase()}</div><div style={{ fontSize:24, fontWeight:800 }}>{v}</div></Card>
        ))}
      </div>

      {patient.notes && (
        <Card style={{ marginBottom:16, background:"#f9fafb" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#9ca3af", marginBottom:4 }}>NOTES</div>
          <div style={{ fontSize:13.5, color:"#374151", lineHeight:1.6 }}>{patient.notes}</div>
        </Card>
      )}

      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {[["docs","📄 Documents"],["sums","📋 Summaries"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{ padding:"6px 16px", borderRadius:999, border:"none", cursor:"pointer", fontSize:13.5, fontWeight:tab===id?700:400, background:tab===id?"#1e3a5f":"#f3f4f6", color:tab===id?"#fff":"#374151" }}>{lbl}</button>
        ))}
      </div>

      {tab === "docs" && (
        docs.length === 0 ? <Empty icon="📄" title="No documents for this patient" action={<Btn onClick={()=>onNav("documents")} variant="secondary">Upload Documents</Btn>} /> :
          <div style={{ display:"grid", gap:8 }}>
            {docs.map(d => (
              <Card key={d.aws_document_id} style={{ display:"flex", gap:12, alignItems:"center" }}>
                <span style={{ fontSize:20 }}>📄</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13.5, fontWeight:500 }}>{d.title||d.file_name}</div>
                  <div style={{ fontSize:12, color:"#6b7280" }}>{d.category} · {d.document_date||"—"}</div>
                </div>
                <StatusBadge status={d.status} />
              </Card>
            ))}
          </div>
      )}

      {tab === "sums" && (
        sums.length === 0 ? <Empty icon="📋" title="No summaries for this patient" action={<Btn onClick={()=>onNav("summaries")} variant="secondary">Create Summary</Btn>} /> :
          <div style={{ display:"grid", gap:8 }}>
            {sums.map(s => (
              <Card key={s.aws_summary_id}>
                <div style={{ fontWeight:600, fontSize:14 }}>{s.patient_name}</div>
                {s.visits?.length > 0 && <div style={{ fontSize:12, color:"#6b7280" }}>{s.visits.length} visits</div>}
              </Card>
            ))}
          </div>
      )}
    </div>
  );
}

// ─── Notes Macros ─────────────────────────────────────────────────────────────
function NotesMacros() {
  const [macros,        setMacros]        = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [showModal,     setShowModal]     = useState(false);
  const [editing,       setEditing]       = useState(null);
  const [form,          setForm]          = useState({ name:"", content:"", section:"" });
  const [copiedId,      setCopiedId]      = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setMacros(await NotesMacro.list()); } catch(e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const sections = ["all", ...new Set(macros.map(m=>m.section).filter(Boolean))];
  const filtered = macros.filter(m => {
    if (sectionFilter !== "all" && m.section !== sectionFilter) return false;
    if (search && !`${m.name} ${m.section||""} ${m.content}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openNew  = ()  => { setEditing(null); setForm({ name:"", content:"", section:"" }); setShowModal(true); };
  const openEdit = (m) => { setEditing(m);    setForm({ name:m.name||"", content:m.content||"", section:m.section||"" }); setShowModal(true); };

  const save = async () => {
    if (!form.name.trim()) return alert("Name required.");
    try {
      if (editing) await NotesMacro.update(editing.id, form);
      else         await NotesMacro.create(form);
      setShowModal(false); load();
    } catch(e) { alert(e.message); }
  };

  const del = async m => {
    if (!confirm(`Delete "${m.name}"?`)) return;
    try { await NotesMacro.delete(m.id); load(); } catch(e) { alert(e.message); }
  };

  const copy = m => {
    navigator.clipboard?.writeText(m.content);
    setCopiedId(m.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Notes Macros" subtitle="Reusable text templates for clinical documentation">
        <Btn onClick={openNew}>+ New Macro</Btn>
      </PageHeader>

      <Card style={{ marginBottom:14, padding:"12px 14px" }}>
        <div style={{ display:"flex", gap:10 }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search macros…"
            style={{ ...inputStyle, flex:1, border:"none", outline:"none", background:"transparent" }} />
          {sections.length > 1 && (
            <select value={sectionFilter} onChange={e=>setSectionFilter(e.target.value)} style={{ ...inputStyle, width:"auto", minWidth:140 }}>
              {sections.map(s => <option key={s} value={s}>{s==="all"?"All Sections":s}</option>)}
            </select>
          )}
        </div>
      </Card>

      {loading ? <Spinner /> : filtered.length === 0 ? (
        <Empty icon="📝" title="No macros yet" sub="Create reusable text snippets for your clinical notes" action={<Btn onClick={openNew}>Create First Macro</Btn>} />
      ) : (
        <div style={{ display:"grid", gap:8 }}>
          {filtered.map(m => (
            <Card key={m.id} style={{ display:"flex", gap:14 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:4 }}>
                  <span style={{ fontSize:14, fontWeight:600, color:"#111827" }}>{m.name}</span>
                  {m.section && <Badge text={m.section} color="#6d28d9" bg="#ede9fe" />}
                </div>
                <div style={{ fontSize:13, color:"#6b7280", lineHeight:1.55, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{m.content}</div>
              </div>
              <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                <Btn onClick={()=>copy(m)} variant="secondary" size="sm">{copiedId===m.id?"✓ Copied":"Copy"}</Btn>
                <Btn onClick={()=>openEdit(m)} variant="secondary" size="sm">Edit</Btn>
                <Btn onClick={()=>del(m)} variant="ghost" size="sm" style={{ color:"#dc2626" }}>Del</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing?"Edit Macro":"New Macro"} onClose={()=>setShowModal(false)}>
          <FInput label="Name" required value={form.name} onChange={v=>setForm(f=>({...f,name:v}))} placeholder="e.g. Normal Gait Exam" />
          <FInput label="Section" value={form.section} onChange={v=>setForm(f=>({...f,section:v}))} placeholder="e.g. Physical Exam, HPI, Assessment" />
          <FTextarea label="Content" value={form.content} onChange={v=>setForm(f=>({...f,content:v}))} rows={8} placeholder="Enter macro text…" />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save}>{editing?"Save Changes":"Create Macro"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────
function Admin() {
  const [tab,         setTab]         = useState("suggestions");
  const [suggestions, setSuggestions] = useState([]);
  const [breaches,    setBreaches]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showBreach,  setShowBreach]  = useState(false);
  const [showSug,     setShowSug]     = useState(false);
  const [bForm,       setBForm]       = useState({ event_type:"", severity:"medium", description:"", affected_users:"", investigation_notes:"", status:"open" });
  const [sForm,       setSForm]       = useState({ title:"", description:"", category:"Feature Request", priority:"medium" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sg, br] = await Promise.all([Suggestion.list(), BreachNotification.list()]);
      setSuggestions(sg); setBreaches(br);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveBreach = async () => {
    if (!bForm.description.trim()) return alert("Description required.");
    try {
      await BreachNotification.create({ ...bForm, detected_date: new Date().toISOString(), notification_sent: false });
      setShowBreach(false); setBForm({ event_type:"", severity:"medium", description:"", affected_users:"", investigation_notes:"", status:"open" }); load();
    } catch(e) { alert(e.message); }
  };

  const saveSug = async () => {
    if (!sForm.title.trim()) return alert("Title required.");
    try { await Suggestion.create(sForm); setShowSug(false); setSForm({ title:"", description:"", category:"Feature Request", priority:"medium" }); load(); }
    catch(e) { alert(e.message); }
  };

  const toggleBreach = async b => {
    try { await BreachNotification.update(b.id, { status: b.status==="resolved"?"open":"resolved" }); load(); } catch(e) { alert(e.message); }
  };
  const updateSugStatus = async (sg, status) => {
    try { await Suggestion.update(sg.id, { status }); load(); } catch(e) { alert(e.message); }
  };

  const sevColor = { low:"#16a34a", medium:"#d97706", high:"#dc2626", critical:"#7f1d1d" };
  const sevBg    = { low:"#dcfce7", medium:"#fef3c7", high:"#fee2e2", critical:"#fce7f3" };

  return (
    <div style={{ padding: 28 }}>
      <PageHeader title="Admin" subtitle="Suggestions and HIPAA compliance tools">
        {tab==="breaches"    && <Btn onClick={()=>setShowBreach(true)} variant="danger">+ Report Breach</Btn>}
        {tab==="suggestions" && <Btn onClick={()=>setShowSug(true)}>+ Add Suggestion</Btn>}
      </PageHeader>

      <div style={{ display:"flex", gap:6, marginBottom:16 }}>
        {[["suggestions","💡 Suggestions"],["breaches","🔒 Breach Log"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{ padding:"6px 18px", borderRadius:999, border:"none", cursor:"pointer", fontSize:13.5, fontWeight:tab===id?700:400, background:tab===id?"#1e3a5f":"#f3f4f6", color:tab===id?"#fff":"#374151" }}>{lbl}</button>
        ))}
      </div>

      {loading ? <Spinner /> : tab==="suggestions" ? (
        suggestions.length===0 ? <Empty icon="💡" title="No suggestions yet" /> :
          <div style={{ display:"grid", gap:8 }}>
            {suggestions.map(sg => (
              <Card key={sg.id} style={{ display:"flex", gap:12 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", gap:8, marginBottom:4, alignItems:"center" }}>
                    <span style={{ fontWeight:600, fontSize:14 }}>{sg.title}</span>
                    {sg.category && <Badge text={sg.category} color="#6b7280" bg="#f3f4f6" />}
                    {sg.priority && <Badge text={sg.priority} color={sevColor[sg.priority]||"#6b7280"} bg={sevBg[sg.priority]||"#f3f4f6"} />}
                  </div>
                  {sg.description && <div style={{ fontSize:13, color:"#6b7280" }}>{sg.description}</div>}
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                  <StatusBadge status={sg.status||"pending"} />
                  <select value={sg.status||"pending"} onChange={e=>updateSugStatus(sg,e.target.value)} style={{ ...inputStyle, width:120, fontSize:12 }}>
                    {["pending","reviewing","planned","completed","rejected"].map(v=><option key={v}>{v}</option>)}
                  </select>
                </div>
              </Card>
            ))}
          </div>
      ) : (
        breaches.length===0 ? <Empty icon="🔒" title="No breach events logged" sub="All clear — no security incidents on record" /> :
          <div style={{ display:"grid", gap:8 }}>
            {breaches.map(b => (
              <Card key={b.id} style={{ display:"flex", gap:12, borderLeft:`4px solid ${sevColor[b.severity]||"#9ca3af"}` }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", gap:8, marginBottom:6, alignItems:"center" }}>
                    <span style={{ fontWeight:600, fontSize:14 }}>{b.event_type||"Security Event"}</span>
                    <Badge text={b.severity||"medium"} color={sevColor[b.severity]||"#6b7280"} bg={sevBg[b.severity]||"#f3f4f6"} />
                    <StatusBadge status={b.status||"open"} />
                  </div>
                  <div style={{ fontSize:13, color:"#4b5563", marginBottom:4 }}>{b.description}</div>
                  <div style={{ fontSize:11.5, color:"#9ca3af" }}>
                    {b.affected_users && <span style={{ marginRight:10 }}>Affected: {b.affected_users}</span>}
                    {b.detected_date  && <span>Detected: {new Date(b.detected_date).toLocaleString()}</span>}
                  </div>
                  {b.investigation_notes && <div style={{ fontSize:12, color:"#6b7280", marginTop:4, fontStyle:"italic" }}>Notes: {b.investigation_notes}</div>}
                </div>
                <Btn onClick={()=>toggleBreach(b)} variant={b.status==="resolved"?"secondary":"success"} size="sm">
                  {b.status==="resolved"?"Reopen":"Resolve"}
                </Btn>
              </Card>
            ))}
          </div>
      )}

      {showBreach && (
        <Modal title="Report Security Breach" subtitle="Logged for HIPAA compliance" onClose={()=>setShowBreach(false)}>
          <FInput label="Event Type" value={bForm.event_type} onChange={v=>setBForm(f=>({...f,event_type:v}))} placeholder="e.g. Unauthorized Access, Data Exposure" />
          <FSelect label="Severity" value={bForm.severity} onChange={v=>setBForm(f=>({...f,severity:v}))} options={["low","medium","high","critical"]} />
          <FTextarea label="Description" value={bForm.description} onChange={v=>setBForm(f=>({...f,description:v}))} rows={4} />
          <FInput label="Affected Users / Records" value={bForm.affected_users} onChange={v=>setBForm(f=>({...f,affected_users:v}))} placeholder="e.g. 0 identified" />
          <FTextarea label="Investigation Notes" value={bForm.investigation_notes} onChange={v=>setBForm(f=>({...f,investigation_notes:v}))} rows={3} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowBreach(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveBreach} variant="danger">Submit Report</Btn>
          </div>
        </Modal>
      )}

      {showSug && (
        <Modal title="Add Suggestion" onClose={()=>setShowSug(false)}>
          <FInput label="Title" required value={sForm.title} onChange={v=>setSForm(f=>({...f,title:v}))} />
          <FTextarea label="Description" value={sForm.description} onChange={v=>setSForm(f=>({...f,description:v}))} rows={4} />
          <FSelect label="Category" value={sForm.category} onChange={v=>setSForm(f=>({...f,category:v}))} options={["Feature Request","Bug Report","UI Improvement","Performance","Other"]} />
          <FSelect label="Priority" value={sForm.priority} onChange={v=>setSForm(f=>({...f,priority:v}))} options={["low","medium","high"]} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowSug(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={saveSug}>Submit</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page,            setPage]            = useState("dashboard");
  const [patients,        setPatients]        = useState([]);
  const [documents,       setDocuments]       = useState([]);
  const [summaries,       setSummaries]       = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [selectedPatient, setSelectedPatient] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const pData = await awsGet("/patients").catch(() => ({ patients: [] }));
      const pts = pData.patients || [];
      setPatients(pts);

      if (pts.length > 0) {
        const docResults = await Promise.all(pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(() => [])));
        setDocuments(docResults.flat());

        const sumResults = await Promise.all(
          pts.map(p => awsGet(`/summaries?patient_id=${p.aws_patient_id}`).catch(() => ({ summaries: [] })))
        );
        setSummaries(sumResults.flatMap(r => r.summaries || []));
      } else {
        setDocuments([]); setSummaries([]);
      }
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const nav = (p) => setPage(p);

  const renderPage = () => {
    if (loading) return <Spinner text="Loading ChartReview Pro…" />;
    switch (page) {
      case "dashboard":     return <Dashboard onNav={nav} patients={patients} documents={documents} summaries={summaries} />;
      case "documents":     return <Documents patients={patients} documents={documents} onRefresh={loadAll} />;
      case "summaries":     return <Summaries summaries={summaries} patients={patients} onRefresh={loadAll} />;
      case "patients":      return <Patients patients={patients} documents={documents} onRefresh={loadAll} onSelectPatient={setSelectedPatient} onNav={nav} />;
      case "patient-detail":return selectedPatient ? <PatientDetail patient={selectedPatient} documents={documents} summaries={summaries} onBack={()=>nav("patients")} onNav={nav} /> : null;
      case "macros":        return <NotesMacros />;
      case "admin":         return <Admin />;
      default:              return null;
    }
  };

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:"#f9fafb", fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <Sidebar page={page} onNav={nav} />
      <div style={{ flex:1, overflow:"auto" }}>{renderPage()}</div>
    </div>
  );
}
