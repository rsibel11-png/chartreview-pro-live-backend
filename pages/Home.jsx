
import { useState, useEffect, useCallback } from "react";
import { callFunction } from "@/api/functions";
import { User } from "@/api/entities";

async function awsGet(path) {
  const data = await callFunction({ function_name: "awsProxy", payload: { method: "GET", path } });
  return data;
}

async function awsPost(path, body) {
  const data = await callFunction({ function_name: "awsProxy", payload: { method: "POST", path, payload: body } });
  return data;
}

async function awsPut(path, body) {
  const data = await callFunction({ function_name: "awsProxy", payload: { method: "PUT", path, payload: body } });
  return data;
}

async function awsDelete(path) {
  const data = await callFunction({ function_name: "awsProxy", payload: { method: "DELETE", path } });
  return data;
}

// ─── Shared Components ────────────────────────────────────────────────────────

function Sidebar({ current, onNav }) {
  const items = [
    { id: "dashboard", icon: "🏠", label: "Dashboard" },
    { id: "patients", icon: "👤", label: "Patients" },
    { id: "documents", icon: "📄", label: "Documents" },
    { id: "summaries", icon: "📋", label: "Summaries" },
    { id: "macros", icon: "📝", label: "Notes Macros" },
    { id: "admin", icon: "⚙️", label: "Admin" },
  ];
  return (
    <div style={{ width: 220, background: "#1e3a5f", color: "white", display: "flex", flexDirection: "column", flexShrink: 0, minHeight: "100vh" }}>
      <div style={{ padding: "24px 20px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>ChartReview Pro</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>HIPAA Compliant ✓</div>
      </div>
      <nav style={{ flex: 1, padding: "12px 0" }}>
        {items.map(item => (
          <button key={item.id} onClick={() => onNav(item.id)} style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%",
            padding: "10px 20px", border: "none",
            background: current === item.id ? "rgba(255,255,255,0.15)" : "transparent",
            color: current === item.id ? "#fff" : "rgba(255,255,255,0.7)",
            cursor: "pointer", fontSize: 14, textAlign: "left",
            borderLeft: current === item.id ? "3px solid #4a9eff" : "3px solid transparent",
          }}>
            <span>{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.1)", fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
        🔒 PHI stored on AWS
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle, action }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: "#1e3a5f" }}>{title}</h1>
        {subtitle && <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function Btn({ onClick, children, variant = "primary", style = {}, disabled }) {
  const styles = {
    primary: { background: "#1e3a5f", color: "#fff" },
    secondary: { background: "#fff", color: "#1e3a5f", border: "1px solid #cbd5e1" },
    danger: { background: "#ef4444", color: "#fff" },
    success: { background: "#10b981", color: "#fff" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "8px 16px", borderRadius: 8, border: "none", cursor: disabled ? "not-allowed" : "pointer",
      fontSize: 14, fontWeight: 500, ...styles[variant], ...style, opacity: disabled ? 0.6 : 1
    }}>{children}</button>
  );
}

function Card({ children, style = {} }) {
  return <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20, ...style }}>{children}</div>;
}

function Badge({ text, color = "#64748b", bg = "#f1f5f9" }) {
  return <span style={{ padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, color, background: bg }}>{text}</span>;
}

function Modal({ title, onClose, children, width = 560 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 28, width, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1e3a5f" }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, required, style = {} }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{label}{required && <span style={{ color: "#ef4444" }}> *</span>}</label>}
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box", outline: "none" }} />
    </div>
  );
}

function Textarea({ label, value, onChange, rows = 4, placeholder }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{label}</label>}
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder}
        style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical", outline: "none" }} />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box", outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Loading() {
  return <div style={{ textAlign: "center", padding: 60, color: "#64748b" }}>Loading...</div>;
}

function Empty({ message, action }) {
  return (
    <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
      <div style={{ fontSize: 16, marginBottom: 16 }}>{message}</div>
      {action}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ onNav }) {
  const [stats, setStats] = useState({ patients: 0, documents: 0, summaries: 0 });
  const [loading, setLoading] = useState(true);
  const [recentPatients, setRecentPatients] = useState([]);

  useEffect(() => {
    Promise.all([
      awsGet("/patients").catch(() => ({ patients: [] })),
    ]).then(([pData]) => {
      const patients = pData.patients || [];
      setStats(s => ({ ...s, patients: patients.length }));
      setRecentPatients(patients.slice(0, 5));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const statCards = [
    { label: "Total Patients", value: stats.patients, icon: "👤", color: "#3b82f6", page: "patients" },
    { label: "Documents", value: stats.documents, icon: "📄", color: "#10b981", page: "documents" },
    { label: "Summaries", value: stats.summaries, icon: "📋", color: "#8b5cf6", page: "summaries" },
  ];

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Dashboard" subtitle="Welcome to ChartReview Pro" />

      {loading ? <Loading /> : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 32 }}>
            {statCards.map(sc => (
              <Card key={sc.label} style={{ cursor: "pointer" }} >
                <div onClick={() => onNav(sc.page)} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ width: 52, height: 52, borderRadius: 12, background: sc.color + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>{sc.icon}</div>
                  <div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#1e293b" }}>{sc.value}</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>{sc.label}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card>
              <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "#1e3a5f" }}>Recent Patients</h3>
              {recentPatients.length === 0 ? (
                <div style={{ color: "#94a3b8", fontSize: 14, textAlign: "center", padding: 20 }}>No patients yet</div>
              ) : (
                recentPatients.map(p => (
                  <div key={p.id} onClick={() => onNav("patients")} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #f1f5f9", cursor: "pointer" }}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#1e3a5f20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>👤</div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{p.first_name} {p.last_name}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>DOB: {p.date_of_birth || "—"}</div>
                    </div>
                  </div>
                ))
              )}
              <div style={{ marginTop: 12 }}>
                <Btn onClick={() => onNav("patients")} variant="secondary" style={{ width: "100%", justifyContent: "center" }}>View All Patients</Btn>
              </div>
            </Card>

            <Card>
              <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "#1e3a5f" }}>Quick Actions</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Btn onClick={() => onNav("patients")} style={{ justifyContent: "flex-start" }}>👤 Add New Patient</Btn>
                <Btn onClick={() => onNav("documents")} style={{ justifyContent: "flex-start" }}>📄 Upload Document</Btn>
                <Btn onClick={() => onNav("summaries")} style={{ justifyContent: "flex-start" }}>📋 Create Summary</Btn>
                <Btn onClick={() => onNav("macros")} variant="secondary" style={{ justifyContent: "flex-start" }}>📝 Manage Notes Macros</Btn>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Patients ─────────────────────────────────────────────────────────────────

function Patients({ onNav, setSelectedPatient }) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ first_name: "", last_name: "", date_of_birth: "", gender: "", case_number: "", provider_name: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    awsGet("/patients").then(d => { setPatients(d.patients || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditing(null); setForm({ first_name: "", last_name: "", date_of_birth: "", gender: "", case_number: "", provider_name: "", notes: "" }); setShowModal(true); };
  const openEdit = (p) => { setEditing(p); setForm({ first_name: p.first_name || "", last_name: p.last_name || "", date_of_birth: p.date_of_birth || "", gender: p.gender || "", case_number: p.case_number || "", provider_name: p.provider_name || "", notes: p.notes || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.first_name || !form.last_name) return alert("First and last name are required.");
    setSaving(true);
    try {
      if (editing) await awsPut(`/patients/${editing.id}`, form);
      else await awsPost("/patients", form);
      setShowModal(false); load();
    } catch (e) { alert("Error saving patient: " + e.message); }
    setSaving(false);
  };

  const del = async (p) => {
    if (!confirm(`Delete patient ${p.first_name} ${p.last_name}? This cannot be undone.`)) return;
    await awsDelete(`/patients/${p.id}`).catch(e => alert(e.message));
    load();
  };

  const filtered = patients.filter(p => `${p.first_name} ${p.last_name} ${p.case_number}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Patients" subtitle={`${patients.length} patients on file`}
        action={<Btn onClick={openNew}>+ New Patient</Btn>} />

      <div style={{ marginBottom: 20 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or case number..."
          style={{ padding: "10px 16px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, width: 320, outline: "none" }} />
      </div>

      {loading ? <Loading /> : filtered.length === 0 ? (
        <Empty message="No patients found" action={<Btn onClick={openNew}>Add First Patient</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {filtered.map(p => (
            <Card key={p.id} style={{ display: "flex", alignItems: "center", gap: 16, cursor: "pointer" }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#1e3a5f15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>👤</div>
              <div style={{ flex: 1 }} onClick={() => { setSelectedPatient(p); onNav("patient-detail"); }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: "#1e293b" }}>{p.first_name} {p.last_name}</div>
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
                  {p.date_of_birth && `DOB: ${p.date_of_birth}`}{p.case_number && ` · Case: ${p.case_number}`}{p.provider_name && ` · Provider: ${p.provider_name}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={() => { setSelectedPatient(p); onNav("patient-detail"); }} variant="secondary">View</Btn>
                <Btn onClick={() => openEdit(p)} variant="secondary">Edit</Btn>
                <Btn onClick={() => del(p)} variant="danger">Delete</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Patient" : "New Patient"} onClose={() => setShowModal(false)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Input label="First Name" value={form.first_name} onChange={v => setForm(f => ({ ...f, first_name: v }))} required />
            <Input label="Last Name" value={form.last_name} onChange={v => setForm(f => ({ ...f, last_name: v }))} required />
            <Input label="Date of Birth" type="date" value={form.date_of_birth} onChange={v => setForm(f => ({ ...f, date_of_birth: v }))} />
            <Select label="Gender" value={form.gender} onChange={v => setForm(f => ({ ...f, gender: v }))} options={[{ value: "", label: "Select..." }, { value: "Male", label: "Male" }, { value: "Female", label: "Female" }, { value: "Other", label: "Other" }]} />
            <Input label="Case Number" value={form.case_number} onChange={v => setForm(f => ({ ...f, case_number: v }))} />
            <Input label="Provider Name" value={form.provider_name} onChange={v => setForm(f => ({ ...f, provider_name: v }))} />
          </div>
          <Textarea label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} rows={3} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving..." : editing ? "Update" : "Create"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Patient Detail ───────────────────────────────────────────────────────────

function PatientDetail({ patient, onNav, onBack }) {
  const [documents, setDocuments] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!patient) return;
    Promise.all([
      awsGet(`/patients/${patient.id}/documents`).catch(() => ({ documents: [] })),
    ]).then(([dData]) => {
      setDocuments(dData.documents || []);
      setLoading(false);
    });
  }, [patient]);

  if (!patient) return <div style={{ padding: 32 }}>No patient selected. <Btn onClick={onBack} variant="secondary">Back</Btn></div>;

  return (
    <div style={{ padding: 32 }}>
      <div style={{ marginBottom: 20 }}>
        <Btn onClick={onBack} variant="secondary">← Back to Patients</Btn>
      </div>
      <PageHeader
        title={`${patient.first_name} ${patient.last_name}`}
        subtitle={[patient.date_of_birth && `DOB: ${patient.date_of_birth}`, patient.case_number && `Case: ${patient.case_number}`, patient.provider_name && `Provider: ${patient.provider_name}`].filter(Boolean).join(" · ")}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1e3a5f" }}>Documents ({documents.length})</h3>
            <Btn onClick={() => onNav("documents")} variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }}>Upload</Btn>
          </div>
          {loading ? <Loading /> : documents.length === 0 ? (
            <div style={{ textAlign: "center", color: "#94a3b8", padding: 20 }}>No documents yet</div>
          ) : (
            documents.map(d => (
              <div key={d.id} style={{ padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{d.title || d.file_name}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>{d.category} · {d.processing_status}</div>
              </div>
            ))
          )}
        </Card>

        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1e3a5f" }}>Summaries ({summaries.length})</h3>
            <Btn onClick={() => onNav("summaries")} variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }}>Create</Btn>
          </div>
          {summaries.length === 0 ? (
            <div style={{ textAlign: "center", color: "#94a3b8", padding: 20 }}>No summaries yet</div>
          ) : (
            summaries.map(s => (
              <div key={s.id} style={{ padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{s.title}</div>
              </div>
            ))
          )}
        </Card>
      </div>

      {patient.notes && (
        <Card style={{ marginTop: 24 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: "#1e3a5f" }}>Notes</h3>
          <p style={{ margin: 0, color: "#374151", fontSize: 14, lineHeight: 1.6 }}>{patient.notes}</p>
        </Card>
      )}
    </div>
  );
}


// ─── Documents ────────────────────────────────────────────────────────────────

function Documents() {
  const [documents, setDocuments] = useState([]);
  const [allDocuments, setAllDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [filterName, setFilterName] = useState("");
  const [uploadForm, setUploadForm] = useState({ patient_name: "", title: "", category: "Medical Records" });
  const [file, setFile] = useState(null);

  const categories = ["Medical Records", "Imaging", "Lab Results", "Operative Notes", "Discharge Summary", "Consultation", "Physical Therapy", "Mental Health", "Legal", "Other"];

  const uploadDoc = async () => {
    if (!file) return alert("Please select a file.");
    if (!uploadForm.patient_name.trim()) return alert("Please enter a patient name or file label.");
    setUploading(true);
    try {
      // Step 1: Create patient record in AWS
      let awsPatientId = null;
      try {
        const pRes = await awsPost("/patients", { patient_name: uploadForm.patient_name.trim() });
        awsPatientId = pRes?.aws_patient_id || null;
      } catch (e) {
        alert("Upload failed at Step 1 (create patient): " + e.message);
        setUploading(false); return;
      }

      // Step 2: Get presigned S3 upload URL
      let uploadData;
      try {
        const docPayload = {
          patient_name: uploadForm.patient_name.trim(),
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          file_size: file.size,
          title: uploadForm.title || file.name,
          category: uploadForm.category,
        };
        if (awsPatientId) docPayload.aws_patient_id = awsPatientId;
        uploadData = await awsPost("/documents/upload-url", docPayload);
        if (!uploadData.upload_url) throw new Error("No upload_url in response: " + JSON.stringify(uploadData));
      } catch (e) {
        alert("Upload failed at Step 2 (get upload URL): " + e.message);
        setUploading(false); return;
      }

      // Step 3: Upload file directly to S3 via presigned URL
      try {
        const s3Res = await fetch(uploadData.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" }
        });
        if (!s3Res.ok) {
          const errText = await s3Res.text().catch(() => "");
          throw new Error("S3 status " + s3Res.status + ": " + errText.substring(0, 200));
        }
      } catch (e) {
        alert("Upload failed at Step 3 (S3 PUT): " + e.message);
        setUploading(false); return;
      }

      // Step 4: Trigger processing
      await awsPost(`/documents/${uploadData.aws_document_id}/process`, {}).catch(() => {});

      alert("Document uploaded successfully! Processing started.");
      setShowUpload(false);
      setFile(null);
      setUploadForm({ patient_name: "", title: "", category: "Medical Records" });
    } catch (e) { alert("Upload failed (unexpected): " + e.message); }
    setUploading(false);
  };

  const filtered = allDocuments.filter(d =>
    !filterName || (d.patient_name || d.title || "").toLowerCase().includes(filterName.toLowerCase())
  );

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Documents" subtitle="Upload and manage medical documents"
        action={<Btn onClick={() => setShowUpload(true)}>+ Upload Document</Btn>} />

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            value={filterName}
            onChange={e => setFilterName(e.target.value)}
            placeholder="Filter by patient name or title..."
            style={{ flex: 1, padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, outline: "none" }}
          />
          {filterName && <Btn onClick={() => setFilterName("")} variant="secondary">Clear</Btn>}
        </div>
      </Card>

      {loading ? <Loading /> : allDocuments.length === 0 ? (
        <Empty message="No documents uploaded yet"
          action={<Btn onClick={() => setShowUpload(true)}>Upload First Document</Btn>} />
      ) : filtered.length === 0 ? (
        <Empty message={`No documents matching "${filterName}"`} action={<Btn onClick={() => setFilterName("")} variant="secondary">Clear Filter</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {filtered.map(d => (
            <Card key={d.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 28 }}>📄</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{d.title || d.file_name}</div>
                  <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
                    {d.patient_name && <span style={{ marginRight: 8 }}>👤 {d.patient_name}</span>}
                    {d.category} · {d.document_date || "No date"} · <Badge text={d.processing_status || "Pending"} color={d.processing_status === "completed" ? "#10b981" : "#f59e0b"} bg={d.processing_status === "completed" ? "#d1fae5" : "#fef3c7"} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={() => setSelectedDoc(d)} variant="secondary">View</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showUpload && (
        <Modal title="Upload Document" onClose={() => setShowUpload(false)}>
          <Input
            label="Patient Name / File Label *"
            value={uploadForm.patient_name}
            onChange={v => setUploadForm(f => ({ ...f, patient_name: v }))}
            placeholder="e.g. John Smith or Case 2024-001"
            required
          />
          <Input label="Document Title" value={uploadForm.title} onChange={v => setUploadForm(f => ({ ...f, title: v }))} placeholder="Leave blank to use filename" />
          <Select label="Category" value={uploadForm.category} onChange={v => setUploadForm(f => ({ ...f, category: v }))}
            options={categories.map(c => ({ value: c, label: c }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>File *</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.tiff" onChange={e => setFile(e.target.files[0])}
              style={{ fontSize: 14 }} />
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowUpload(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={uploadDoc} disabled={uploading}>{uploading ? "Uploading..." : "Upload"}</Btn>
          </div>
        </Modal>
      )}

      {selectedDoc && (
        <Modal title={selectedDoc.title || selectedDoc.file_name} onClose={() => setSelectedDoc(null)} width={800}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            {selectedDoc.patient_name && <div><span style={{ fontSize: 12, color: "#64748b" }}>Patient</span><div style={{ fontWeight: 500 }}>{selectedDoc.patient_name}</div></div>}
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Category</span><div style={{ fontWeight: 500 }}>{selectedDoc.category}</div></div>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Status</span><div style={{ fontWeight: 500 }}>{selectedDoc.processing_status}</div></div>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Date</span><div style={{ fontWeight: 500 }}>{selectedDoc.document_date || "—"}</div></div>
          </div>
          {selectedDoc.extracted_text && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 8 }}>Extracted Text</div>
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 16, maxHeight: 300, overflow: "auto", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                {selectedDoc.extracted_text}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── Summaries ────────────────────────────────────────────────────────────────

function Summaries() {
  const [summaries, setSummaries] = useState([]);
  const [patients, setPatients] = useState([]);
  const [macros, setMacros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    patient_id: "", case_number: "", header_note: "", ime_note: "", chart_review_note: "",
    physical_examination_note: "", discussion_note: "", footer_note: "", status: "Draft"
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pData, sData] = await Promise.all([
        awsGet("/patients").catch(() => ({ patients: [] })),
        awsGet("/summaries").catch(() => ({ summaries: [] })),
      ]);
      setPatients(pData.patients || []);
      setSummaries(sData.summaries || []);
    } catch (e) {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load macros from Base44
  useEffect(() => {
    import("../api/entities").then(({ NotesMacro }) => {
      NotesMacro.list().then(setMacros).catch(() => {});
    });
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm({ patient_id: "", case_number: "", header_note: "", ime_note: "", chart_review_note: "", physical_examination_note: "", discussion_note: "", footer_note: "", status: "Draft" });
    setShowForm(true);
  };

  const openEdit = (s) => {
    setEditing(s);
    setForm({ patient_id: s.patient_id || "", case_number: s.case_number || "", header_note: s.header_note || "", ime_note: s.ime_note || "", chart_review_note: s.chart_review_note || "", physical_examination_note: s.physical_examination_note || "", discussion_note: s.discussion_note || "", footer_note: s.footer_note || "", status: s.status || "Draft" });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.patient_id) return alert("Please select a patient.");
    setSaving(true);
    try {
      const patient = patients.find(p => p.id === form.patient_id);
      const payload = { ...form, patient_name: patient ? `${patient.first_name} ${patient.last_name}` : "" };
      if (editing) await awsPut(`/summaries/${editing.id}`, payload);
      else await awsPost("/summaries", payload);
      setShowForm(false);
      load();
    } catch (e) { alert("Error: " + e.message); }
    setSaving(false);
  };

  const del = async (s) => {
    if (!confirm("Delete this summary?")) return;
    await awsDelete(`/summaries/${s.id}`).catch(e => alert(e.message));
    load();
  };

  const insertMacro = (field, macro) => {
    setForm(f => ({ ...f, [field]: (f[field] ? f[field] + "\n\n" : "") + macro.content }));
  };

  const sectionField = (label, field) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#1e3a5f" }}>{label}</label>
        {macros.filter(m => m.section === label || !m.section).length > 0 && (
          <select onChange={e => { if (e.target.value) { const m = macros.find(x => x.id === e.target.value); if (m) insertMacro(field, m); e.target.value = ""; } }}
            style={{ fontSize: 12, padding: "3px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }}>
            <option value="">Insert macro...</option>
            {macros.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>
      <textarea value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} rows={4}
        style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical" }} />
    </div>
  );

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Medical Summaries" subtitle={`${summaries.length} summaries`}
        action={<Btn onClick={openNew}>+ New Summary</Btn>} />

      {loading ? <Loading /> : summaries.length === 0 ? (
        <Empty message="No summaries yet" action={<Btn onClick={openNew}>Create First Summary</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {summaries.map(s => (
            <Card key={s.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 28 }}>📋</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{s.patient_name || "Unknown Patient"}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>Case: {s.case_number || "—"} · <Badge text={s.status || "Draft"} color={s.status === "Final" ? "#10b981" : "#f59e0b"} bg={s.status === "Final" ? "#d1fae5" : "#fef3c7"} /></div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={() => openEdit(s)} variant="secondary">Edit</Btn>
                  <Btn onClick={() => del(s)} variant="danger">Delete</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title={editing ? "Edit Summary" : "New Summary"} onClose={() => setShowForm(false)} width={760}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Select label="Patient *" value={form.patient_id} onChange={v => setForm(f => ({ ...f, patient_id: v }))}
              options={[{ value: "", label: "Select patient..." }, ...patients.map(p => ({ value: p.id, label: `${p.first_name} ${p.last_name}` }))]} />
            <Input label="Case Number" value={form.case_number} onChange={v => setForm(f => ({ ...f, case_number: v }))} />
          </div>
          <Select label="Status" value={form.status} onChange={v => setForm(f => ({ ...f, status: v }))}
            options={[{ value: "Draft", label: "Draft" }, { value: "In Progress", label: "In Progress" }, { value: "Final", label: "Final" }]} />
          {sectionField("Header Note", "header_note")}
          {sectionField("IME Note", "ime_note")}
          {sectionField("Chart Review Note", "chart_review_note")}
          {sectionField("Physical Examination Note", "physical_examination_note")}
          {sectionField("Discussion Note", "discussion_note")}
          {sectionField("Footer Note", "footer_note")}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <Btn onClick={() => setShowForm(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving..." : editing ? "Update" : "Create"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Notes Macros ─────────────────────────────────────────────────────────────

function NotesMacros() {
  const [macros, setMacros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [NotesMacroEntity, setEntity] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", content: "", section: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    import("../api/entities").then(({ NotesMacro }) => {
      setEntity(() => NotesMacro);
      NotesMacro.list().then(setMacros).catch(() => {}).finally(() => setLoading(false));
    });
  }, []);

  const load = () => NotesMacroEntity?.list().then(setMacros).catch(() => {});

  const openNew = () => { setEditing(null); setForm({ name: "", content: "", section: "" }); setShowModal(true); };
  const openEdit = (m) => { setEditing(m); setForm({ name: m.name, content: m.content, section: m.section || "" }); setShowModal(true); };

  const save = async () => {
    if (!form.name || !form.content) return alert("Name and content are required.");
    setSaving(true);
    try {
      if (editing) await NotesMacroEntity.update(editing.id, form);
      else await NotesMacroEntity.create(form);
      setShowModal(false); load();
    } catch (e) { alert("Error: " + e.message); }
    setSaving(false);
  };

  const del = async (m) => {
    if (!confirm("Delete this macro?")) return;
    await NotesMacroEntity.delete(m.id).catch(e => alert(e.message));
    load();
  };

  const sections = ["Header Note", "IME Note", "Chart Review Note", "Physical Examination Note", "Discussion Note", "Footer Note"];

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Notes Macros" subtitle="Reusable text snippets for summary sections"
        action={<Btn onClick={openNew}>+ New Macro</Btn>} />

      {loading ? <Loading /> : macros.length === 0 ? (
        <Empty message="No macros yet — create reusable text snippets for your summaries" action={<Btn onClick={openNew}>Create First Macro</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {macros.map(m => (
            <Card key={m.id}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                <div style={{ fontSize: 28 }}>📝</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{m.name}</div>
                  {m.section && <Badge text={m.section} color="#6366f1" bg="#eef2ff" />}
                  <div style={{ fontSize: 13, color: "#64748b", marginTop: 6, lineHeight: 1.6, maxHeight: 60, overflow: "hidden" }}>{m.content}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={() => openEdit(m)} variant="secondary">Edit</Btn>
                  <Btn onClick={() => del(m)} variant="danger">Delete</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Macro" : "New Macro"} onClose={() => setShowModal(false)}>
          <Input label="Macro Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required placeholder="e.g. Normal Physical Exam" />
          <Select label="Section (optional)" value={form.section} onChange={v => setForm(f => ({ ...f, section: v }))}
            options={[{ value: "", label: "Any section" }, ...sections.map(s => ({ value: s, label: s }))]} />
          <Textarea label="Content" value={form.content} onChange={v => setForm(f => ({ ...f, content: v }))} rows={6} placeholder="Enter the text that will be inserted..." />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving..." : editing ? "Update" : "Create"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────

function Admin() {
  const [tab, setTab] = useState("breaches");
  const [breaches, setBreaches] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [BreachEntity, setBreachEntity] = useState(null);
  const [SuggestionEntity, setSuggestionEntity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState("breach");
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    import("../api/entities").then(({ BreachNotification, Suggestion }) => {
      setBreachEntity(() => BreachNotification);
      setSuggestionEntity(() => Suggestion);
      Promise.all([BreachNotification.list(), Suggestion.list()]).then(([b, s]) => {
        setBreaches(b); setSuggestions(s); setLoading(false);
      }).catch(() => setLoading(false));
    });
  }, []);

  const load = () => {
    BreachEntity?.list().then(setBreaches).catch(() => {});
    SuggestionEntity?.list().then(setSuggestions).catch(() => {});
  };

  const openBreach = () => { setModalType("breach"); setForm({ event_type: "", severity: "Medium", description: "", affected_users: "", status: "Open", detected_date: new Date().toISOString().split("T")[0] }); setShowModal(true); };
  const openSuggestion = () => { setModalType("suggestion"); setForm({ title: "", description: "", category: "", priority: "Medium", status: "Pending" }); setShowModal(true); };

  const save = async () => {
    setSaving(true);
    try {
      if (modalType === "breach") await BreachEntity.create(form);
      else await SuggestionEntity.create(form);
      setShowModal(false); load();
    } catch (e) { alert("Error: " + e.message); }
    setSaving(false);
  };

  const severityColor = { Low: "#10b981", Medium: "#f59e0b", High: "#ef4444", Critical: "#7c3aed" };

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Admin" subtitle="Security, compliance, and feedback" />

      <div style={{ display: "flex", gap: 8, marginBottom: 24, borderBottom: "1px solid #e2e8f0", paddingBottom: 0 }}>
        {[{ id: "breaches", label: "🔒 Breach Log" }, { id: "suggestions", label: "💡 Suggestions" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 20px", border: "none", background: "none", cursor: "pointer", fontSize: 14,
            color: tab === t.id ? "#1e3a5f" : "#64748b", fontWeight: tab === t.id ? 600 : 400,
            borderBottom: tab === t.id ? "2px solid #1e3a5f" : "2px solid transparent", marginBottom: -1
          }}>{t.label}</button>
        ))}
      </div>

      {loading ? <Loading /> : tab === "breaches" ? (
        <>
          <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={openBreach}>+ Log Breach Event</Btn>
          </div>
          {breaches.length === 0 ? <Empty message="No breach events logged" /> : (
            <div style={{ display: "grid", gap: 12 }}>
              {breaches.map(b => (
                <Card key={b.id}>
                  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <Badge text={b.severity} color="#fff" bg={severityColor[b.severity] || "#64748b"} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{b.event_type}</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>{b.description}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Detected: {b.detected_date} · Status: {b.status}</div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={openSuggestion}>+ Submit Suggestion</Btn>
          </div>
          {suggestions.length === 0 ? <Empty message="No suggestions yet" /> : (
            <div style={{ display: "grid", gap: 12 }}>
              {suggestions.map(s => (
                <Card key={s.id}>
                  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <Badge text={s.priority} color={s.priority === "High" ? "#ef4444" : s.priority === "Medium" ? "#f59e0b" : "#10b981"}
                      bg={s.priority === "High" ? "#fee2e2" : s.priority === "Medium" ? "#fef3c7" : "#d1fae5"} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{s.title}</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>{s.description}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Status: {s.status}</div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {showModal && (
        <Modal title={modalType === "breach" ? "Log Breach Event" : "Submit Suggestion"} onClose={() => setShowModal(false)}>
          {modalType === "breach" ? (
            <>
              <Input label="Event Type" value={form.event_type} onChange={v => setForm(f => ({ ...f, event_type: v }))} placeholder="e.g. Unauthorized Access" required />
              <Select label="Severity" value={form.severity} onChange={v => setForm(f => ({ ...f, severity: v }))}
                options={["Low", "Medium", "High", "Critical"].map(s => ({ value: s, label: s }))} />
              <Input label="Detected Date" type="date" value={form.detected_date} onChange={v => setForm(f => ({ ...f, detected_date: v }))} />
              <Textarea label="Description" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} required />
              <Input label="Affected Users" value={form.affected_users} onChange={v => setForm(f => ({ ...f, affected_users: v }))} />
            </>
          ) : (
            <>
              <Input label="Title" value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} required />
              <Input label="Category" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} />
              <Select label="Priority" value={form.priority} onChange={v => setForm(f => ({ ...f, priority: v }))}
                options={["Low", "Medium", "High"].map(p => ({ value: p, label: p }))} />
              <Textarea label="Description" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} required />
            </>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <Btn onClick={() => setShowModal(false)} variant="secondary">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Saving..." : "Submit"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    User.me()
      .then(u => { setCurrentUser(u || null); setAuthLoading(false); })
      .catch(() => { setCurrentUser(null); setAuthLoading(false); });
  }, []);

  const navigate = (p) => setPage(p);

  const renderPage = () => {
    switch (page) {
      case "dashboard": return <Dashboard onNav={navigate} />;
      case "patients": return <Patients onNav={navigate} setSelectedPatient={setSelectedPatient} />;
      case "patient-detail": return <PatientDetail patient={selectedPatient} onNav={navigate} onBack={() => navigate("patients")} />;
      case "documents": return <Documents />;
      case "summaries": return <Summaries />;
      case "macros": return <NotesMacros />;
      case "admin": return <Admin />;
      default: return <Dashboard onNav={navigate} />;
    }
  };

  if (authLoading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "Inter, sans-serif", background: "#f8fafc" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🏥</div>
        <div style={{ color: "#64748b" }}>Loading ChartReview Pro...</div>
      </div>
    </div>
  );

  if (!currentUser) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "Inter, sans-serif", background: "#f8fafc" }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 40, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", textAlign: "center", maxWidth: 400, width: "100%" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🏥</div>
        <h2 style={{ margin: "0 0 8px", color: "#1e3a5f", fontSize: 22 }}>ChartReview Pro</h2>
        <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>HIPAA-compliant document management</p>
        <a href={`https://friday-app-3f4e9d76.base44.app/login`}
          style={{ display: "inline-block", background: "#1e3a5f", color: "#fff", padding: "12px 32px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 15 }}>
          Sign In
        </a>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'Inter', -apple-system, sans-serif", background: "#f8fafc" }}>
      <Sidebar current={page} onNav={navigate} />
      <div style={{ flex: 1, overflow: "auto" }}>
        {renderPage()}
      </div>
    </div>
  );
}
