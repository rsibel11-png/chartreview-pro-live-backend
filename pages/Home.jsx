/**
 * ChartReview Pro — AWS-backed clone
 * Original UI faithfully reproduced. Data layer: AWS API via awsProxy backend function.
 * Non-PHI entities (NotesMacro, Suggestion, BreachNotification) remain on Base44.
 */
import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { NotesMacro, Suggestion, BreachNotification } from "@/api/entities";

// ─── AWS Proxy ────────────────────────────────────────────────────────────────
const PROXY = "https://friday-e54fce34.base44.app/functions/awsProxy";
async function aws(method, path, body) {
  const r = await fetch(PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path, payload: body }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `AWS error ${r.status}`);
  }
  return r.json();
}
const awsGet  = p    => aws("GET",    p);
const awsPost = (p,b)=> aws("POST",   p, b);
const awsPut  = (p,b)=> aws("PUT",    p, b);
const awsDel  = p    => aws("DELETE", p);

// ─── Upload Context (global, so progress shows in sidebar) ────────────────────
const UploadCtx = createContext(null);
const useUpload = () => useContext(UploadCtx);

function UploadProvider({ children }) {
  const [queue, setQueue]     = useState([]);   // {id,file,patient,case,category,folder,status,error}
  const [running, setRunning] = useState(false);
  const [folder, setFolder]   = useState("");
  const cancelRef             = useRef(false);

  const addFiles = useCallback((files, defaults = {}) => {
    const items = Array.from(files).map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      patient: defaults.patient || "",
      caseNum: defaults.caseNum || "",
      category: defaults.category || "Medical Records",
      folder: defaults.folder || folder,
      status: "pending",  // pending | uploading | completed | error | cancelled
      error: null,
      documentId: null,
      isDuplicate: false,
      hasDuplicatePages: false,
    }));
    setQueue(q => [...q, ...items]);
  }, [folder]);

  const removeFile  = id => setQueue(q => q.filter(f => f.id !== id));
  const clearDone   = () => setQueue(q => q.filter(f => f.status === "pending" || f.status === "uploading"));
  const updateItem  = (id, upd) => setQueue(q => q.map(f => f.id === id ? { ...f, ...upd } : f));

  const uploadAll = useCallback(async () => {
    cancelRef.current = false;
    setRunning(true);
    const pending = queue.filter(f => f.status === "pending");
    for (const item of pending) {
      if (cancelRef.current) { updateItem(item.id, { status: "cancelled" }); continue; }
      updateItem(item.id, { status: "uploading" });
      try {
        // 1. Ensure patient exists
        const pRes = await awsPost("/patients", {
          patient_name: item.patient || "Unknown",
          case_number: item.caseNum || undefined,
        });
        const pid = pRes?.aws_patient_id;

        // 2. Get presigned S3 URL
        const up = await awsPost("/documents/upload-url", {
          aws_patient_id: pid,
          patient_name: item.patient || "Unknown",
          file_name: item.file.name,
          content_type: item.file.type || "application/octet-stream",
          title: item.file.name,
          category: item.category,
          case_number: item.caseNum || undefined,
          folder: item.folder || undefined,
        });
        if (!up.upload_url) throw new Error("No upload URL");

        // 3. PUT to S3
        const s3 = await fetch(up.upload_url, {
          method: "PUT", body: item.file,
          headers: { "Content-Type": item.file.type || "application/octet-stream" },
        });
        if (!s3.ok) throw new Error(`S3 upload failed: ${s3.status}`);

        // 4. Trigger AI processing (non-fatal)
        await awsPost(`/documents/${up.aws_document_id}/process`, {}).catch(() => {});

        updateItem(item.id, { status: "completed", documentId: up.aws_document_id });
      } catch (e) {
        updateItem(item.id, { status: "error", error: e.message });
      }
    }
    setRunning(false);
  }, [queue]);

  const stopUpload = () => { cancelRef.current = true; };

  const value = { queue, setQueue, running, addFiles, removeFile, clearDone, updateItem, uploadAll, stopUpload, folder, setFolder };
  return <UploadCtx.Provider value={value}>{children}</UploadCtx.Provider>;
}

// ─── Colour tokens (match original Tailwind theme) ───────────────────────────
const C = {
  blue600: "#2563eb", blue700: "#1d4ed8", blue50: "#eff6ff",
  cyan500: "#06b6d4",
  slate900: "#0f172a", slate700: "#334155", slate600: "#475569",
  slate500: "#64748b", slate400: "#94a3b8", slate200: "#e2e8f0",
  slate100: "#f1f5f9", slate50: "#f8fafc",
  green600: "#16a34a", green50: "#f0fdf4",
  amber600: "#d97706", amber50: "#fffbeb", amber200: "#fde68a",
  red600: "#dc2626", red50: "#fef2f2",
  purple500: "#8b5cf6",
  white: "#ffffff",
};

// ─── Shared UI primitives ─────────────────────────────────────────────────────
const btn = {
  base:      { borderRadius:8, border:"none", cursor:"pointer", fontSize:14, fontWeight:500, padding:"8px 16px", display:"inline-flex", alignItems:"center", gap:6 },
  primary:   { background: C.blue600, color:"#fff" },
  secondary: { background:"#fff", color:C.slate700, border:`1px solid ${C.slate200}` },
  outline:   { background:"transparent", color:C.slate600, border:`1px solid ${C.slate200}` },
  danger:    { background: C.red600, color:"#fff" },
  ghost:     { background:"transparent", color:C.slate500, border:"none" },
  success:   { background: C.green600, color:"#fff" },
  sm:        { padding:"5px 12px", fontSize:12.5 },
  xs:        { padding:"3px 8px", fontSize:11.5 },
};
function Btn({ children, onClick, variant="primary", size="md", disabled, style={}, className="" }) {
  const sz = size==="sm" ? btn.sm : size==="xs" ? btn.xs : {};
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...btn.base, ...btn[variant]||btn.primary, ...sz, opacity:disabled?0.5:1, cursor:disabled?"not-allowed":"pointer", ...style }}>
      {children}
    </button>
  );
}

const cardStyle = { background:C.white, borderRadius:12, border:`1px solid ${C.slate200}`, padding:"20px", boxShadow:"0 1px 3px rgba(0,0,0,0.06)" };
function Card({ children, style={}, onClick }) {
  return <div onClick={onClick} style={{ ...cardStyle, ...(onClick?{cursor:"pointer"}:{}), ...style }}>{children}</div>;
}

function Badge({ children, color=C.slate500, bg=C.slate100 }) {
  return <span style={{ display:"inline-flex", padding:"2px 10px", borderRadius:999, fontSize:12, fontWeight:500, color, background:bg, whiteSpace:"nowrap" }}>{children}</span>;
}

function Modal({ title, description, onClose, children, width=600 }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16, overflowY:"auto" }}>
      <div style={{ background:C.white, borderRadius:14, width, maxWidth:"96vw", maxHeight:"92vh", overflow:"auto", boxShadow:"0 24px 64px rgba(0,0,0,0.25)" }}>
        <div style={{ padding:"22px 24px 0", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ fontSize:18, fontWeight:700, color:C.slate900 }}>{title}</div>
            {description && <div style={{ fontSize:13, color:C.slate500, marginTop:3 }}>{description}</div>}
          </div>
          <button onClick={onClose} style={{ background:C.slate100, border:"none", borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:14, color:C.slate500 }}>✕</button>
        </div>
        <div style={{ padding:"18px 24px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function AlertDialog({ title, description, onConfirm, onCancel, confirmLabel="Confirm", danger=false }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:1100, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:C.white, borderRadius:12, padding:24, maxWidth:440, width:"90vw", boxShadow:"0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ fontSize:17, fontWeight:700, color:C.slate900, marginBottom:8 }}>{title}</div>
        <div style={{ fontSize:14, color:C.slate500, marginBottom:20 }}>{description}</div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <Btn onClick={onCancel} variant="outline">Cancel</Btn>
          <Btn onClick={onConfirm} variant={danger?"danger":"primary"}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

const inp = { width:"100%", padding:"9px 12px", border:`1px solid ${C.slate200}`, borderRadius:8, fontSize:14, boxSizing:"border-box", outline:"none", color:C.slate900, background:C.white };
function FInput({ label, value, onChange, placeholder, required, type="text", style={} }) {
  return (
    <div style={{ marginBottom:14, ...style }}>
      {label && <label style={{ display:"block", fontSize:13, fontWeight:500, color:C.slate700, marginBottom:5 }}>{label}{required&&<span style={{color:C.red600}}> *</span>}</label>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={inp} />
    </div>
  );
}
function FTextarea({ label, value, onChange, rows=4, placeholder }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <label style={{ display:"block", fontSize:13, fontWeight:500, color:C.slate700, marginBottom:5 }}>{label}</label>}
      <textarea value={value} onChange={e=>onChange(e.target.value)} rows={rows} placeholder={placeholder} style={{ ...inp, resize:"vertical" }} />
    </div>
  );
}
function FSelect({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <label style={{ display:"block", fontSize:13, fontWeight:500, color:C.slate700, marginBottom:5 }}>{label}</label>}
      <select value={value} onChange={e=>onChange(e.target.value)} style={inp}>
        {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
      </select>
    </div>
  );
}

function Progress({ value }) {
  return (
    <div style={{ background:C.slate200, borderRadius:999, height:6, overflow:"hidden" }}>
      <div style={{ background:C.blue600, height:"100%", width:`${value}%`, transition:"width 0.3s" }} />
    </div>
  );
}

function Spinner({ text="Loading..." }) {
  return <div style={{ padding:60, textAlign:"center", color:C.slate400, fontSize:14 }}>{text}</div>;
}

function Empty({ icon="📭", title, sub, action }) {
  return (
    <div style={{ textAlign:"center", padding:"52px 20px", color:C.slate400 }}>
      <div style={{ fontSize:44, marginBottom:10 }}>{icon}</div>
      <div style={{ fontSize:15, fontWeight:600, color:C.slate600, marginBottom:4 }}>{title}</div>
      {sub && <div style={{ fontSize:13, marginBottom:16 }}>{sub}</div>}
      {action}
    </div>
  );
}

function StatusBadge({ status }) {
  const m = {
    completed:  ["✓ Completed",  C.green600, "#dcfce7"],
    processed:  ["✓ Processed",  C.green600, "#dcfce7"],
    processing: ["Processing…",  C.amber600, "#fef3c7"],
    pending:    ["Pending",      C.amber600, "#fef3c7"],
    uploaded:   ["Uploaded",     C.slate500, C.slate100],
    failed:     ["Failed",       C.red600,   "#fee2e2"],
    error:      ["Error",        C.red600,   "#fee2e2"],
    open:       ["Open",         C.red600,   "#fee2e2"],
    resolved:   ["Resolved",     C.green600, "#dcfce7"],
  };
  const [t, c, bg] = m[status] || m.uploaded;
  return <Badge color={c} bg={bg}>{t}</Badge>;
}

const CATEGORIES = ["Medical Records","Imaging","Lab Results","Operative Notes","Discharge Summary","Consultation","Physical Therapy","Mental Health","Legal","Other"];

// ─── Layout / Sidebar ─────────────────────────────────────────────────────────
function Layout({ page, onNav, children }) {
  const { queue, running } = useUpload();
  const uploading = queue.filter(f=>f.status==="uploading").length;
  const completed = queue.filter(f=>f.status==="completed").length;
  const pending   = queue.filter(f=>f.status==="pending").length;

  const navItems = [
    { id:"dashboard",  icon:"🏠", label:"Dashboard"         },
    { id:"upload",     icon:"⬆️", label:"Upload Documents"   },
    { id:"library",    icon:"📚", label:"Document Library"   },
    { id:"duplicates", icon:"📋", label:"Duplicate Manager"  },
    { id:"summaries",  icon:"✅", label:"Medical Summaries"  },
    { id:"splitpdf",   icon:"✂️", label:"Split PDF"          },
    { id:"breaches",   icon:"⚠️", label:"Breach Notifications"},
    { id:"users",      icon:"👥", label:"Invite Users"       },
    { id:"suggestions",icon:"💬", label:"Suggestions"        },
    { id:"settings",   icon:"⚙️", label:"Settings"           },
  ];

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:`linear-gradient(135deg, ${C.slate50}, #eff6ff)`, fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width:240, background:C.white, borderRight:`1px solid ${C.slate200}`, display:"flex", flexDirection:"column", minHeight:"100vh", flexShrink:0, boxShadow:"1px 0 4px rgba(0,0,0,0.04)" }}>
        {/* Header */}
        <div style={{ padding:"24px 20px 16px", borderBottom:`1px solid ${C.slate200}` }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:40, height:40, background:"linear-gradient(135deg,#2563eb,#06b6d4)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>📄</div>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:C.slate900 }}>ChartReview Pro</div>
              <div style={{ fontSize:11, color:C.slate500 }}>Document Management</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex:1, padding:"10px 12px", overflowY:"auto" }}>
          <div style={{ fontSize:11, fontWeight:600, color:C.slate400, textTransform:"uppercase", letterSpacing:"0.6px", padding:"6px 8px 4px" }}>Navigation</div>
          {navItems.map(it => {
            const active = page === it.id;
            return (
              <button key={it.id} onClick={()=>onNav(it.id)} style={{
                display:"flex", alignItems:"center", gap:10, width:"100%",
                padding:"10px 12px", marginBottom:2, border:"none", borderRadius:9,
                cursor:"pointer", fontSize:14, textAlign:"left", fontWeight: active?600:400,
                background: active ? "linear-gradient(90deg,#eff6ff,#cffafe)" : "transparent",
                color: active ? C.blue700 : C.slate700,
                boxShadow: active ? "0 1px 3px rgba(37,99,235,0.12)" : "none",
              }}>
                <span style={{ fontSize:15 }}>{it.icon}</span>
                <span>{it.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Upload progress strip */}
        {queue.length > 0 && (
          <div style={{ padding:"10px 14px", borderTop:`1px solid ${C.slate200}`, background:C.slate50 }}>
            <div style={{ fontSize:12, fontWeight:600, color:C.slate600, marginBottom:5 }}>
              {running ? `Uploading ${uploading} file${uploading!==1?"s":""}…` : `${completed}/${queue.length} files done`}
            </div>
            <Progress value={queue.length > 0 ? (completed/queue.length)*100 : 0} />
          </div>
        )}

        {/* Footer */}
        <div style={{ padding:"14px 20px", borderTop:`1px solid ${C.slate200}` }}>
          <div style={{ fontSize:11, color:C.slate400 }}>🔒 PHI stored on AWS · BAA Active</div>
        </div>
      </div>

      {/* Main */}
      <main style={{ flex:1, overflow:"auto" }}>{children}</main>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ onNav, patients, documents, summaries }) {
  const processed = documents.filter(d=>["completed","processed"].includes(d.status)).length;
  const duplicates = documents.filter(d=>d.is_duplicate).length;
  const dupePages  = documents.filter(d=>d.has_duplicate_pages).length;
  const recent     = [...documents].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,5);

  const quickCards = [
    { icon:"⬆️", label:"Upload New", sub:"Documents",    color:"#2563eb", grad:"linear-gradient(135deg,#3b82f6,#06b6d4)", page:"upload"    },
    { icon:"📚", label:"View All",   sub:"Library",      color:"#7c3aed", grad:"linear-gradient(135deg,#8b5cf6,#ec4899)", page:"library"   },
    { icon:"📋", label:"Manage",     sub:"Duplicates",   color:"#d97706", grad:"linear-gradient(135deg,#f59e0b,#f97316)", page:"duplicates"},
    { icon:"✅", label:"Create",     sub:"Summaries",    color:"#16a34a", grad:"linear-gradient(135deg,#22c55e,#10b981)", page:"summaries" },
  ];

  return (
    <div style={{ padding:"32px" }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ fontSize:32, fontWeight:700, color:C.slate900, margin:0 }}>Dashboard</h1>
        <p style={{ color:C.slate600, marginTop:4 }}>Medical-Legal document management overview</p>
      </div>

      {/* Quick Actions */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:16, marginBottom:28 }}>
        {quickCards.map(qc => (
          <Card key={qc.page} onClick={()=>onNav(qc.page)} style={{ cursor:"pointer", transition:"box-shadow 0.2s", background:`linear-gradient(135deg,${qc.color}08,${qc.color}14)`, border:`2px solid ${qc.color}20` }}>
            <div style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ width:48, height:48, borderRadius:12, background:qc.grad, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, boxShadow:"0 4px 12px rgba(0,0,0,0.15)" }}>{qc.icon}</div>
              <div>
                <div style={{ fontSize:12.5, color:C.slate600, fontWeight:500 }}>{qc.label}</div>
                <div style={{ fontSize:17, fontWeight:700, color:C.slate900 }}>{qc.sub}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:14, marginBottom:28 }}>
        {[
          ["Total Docs",  documents.length,  C.slate500],
          ["Medical",     documents.filter(d=>d.category?.toLowerCase()==="medical").length, C.cyan500],
          ["Legal",       documents.filter(d=>d.category?.toLowerCase()==="legal").length,   C.blue600],
          ["Duplicates",  duplicates,         C.amber600],
          ["Summaries",   summaries.length,   C.green600],
          ["Processing",  documents.filter(d=>["processing","pending"].includes(d.status)).length, C.purple500],
        ].map(([label,val,color])=>(
          <Card key={label}>
            <div style={{ fontSize:12, color:C.slate500, fontWeight:500, marginBottom:4 }}>{label}</div>
            <div style={{ fontSize:28, fontWeight:700, color }}>{val}</div>
          </Card>
        ))}
      </div>

      {/* Alerts */}
      {dupePages > 0 && (
        <div onClick={()=>onNav("library")} style={{ background:C.amber50, border:`1px solid ${C.amber200}`, borderRadius:10, padding:"12px 16px", marginBottom:18, cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>⚠️</span>
          <span style={{ fontSize:13.5, color:"#92400e", fontWeight:500 }}>{dupePages} document{dupePages!==1?"s have":" has"} duplicate pages detected — click to review</span>
        </div>
      )}

      {/* Recent */}
      <div style={{ display:"grid", gridTemplateColumns:"1.3fr 1fr", gap:20 }}>
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div style={{ fontSize:15, fontWeight:600, color:C.slate900 }}>Recent Documents</div>
            <Btn onClick={()=>onNav("library")} variant="outline" size="sm">View All →</Btn>
          </div>
          {recent.length===0 ? <div style={{ color:C.slate400, textAlign:"center", padding:20, fontSize:13 }}>No documents yet</div>
            : recent.map(d=>(
              <div key={d.aws_document_id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid ${C.slate100}` }}>
                <span style={{ fontSize:18 }}>📄</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, fontWeight:500, color:C.slate900, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.title||d.file_name}</div>
                  <div style={{ fontSize:12, color:C.slate400 }}>{d.patient_name||"—"} · {d.category||"—"}</div>
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))
          }
        </Card>

        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div style={{ fontSize:15, fontWeight:600, color:C.slate900 }}>Patients</div>
            <Btn onClick={()=>onNav("upload")} variant="outline" size="sm">Upload →</Btn>
          </div>
          {patients.length===0 ? <div style={{ color:C.slate400, textAlign:"center", padding:20, fontSize:13 }}>No patients yet</div>
            : patients.slice(0,6).map(p=>(
              <div key={p.aws_patient_id} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom:`1px solid ${C.slate100}` }}>
                <div style={{ width:32, height:32, borderRadius:"50%", background:C.blue50, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, color:C.blue600, fontSize:13 }}>
                  {(p.patient_name||"?")[0].toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.patient_name}</div>
                  {p.case_number && <div style={{ fontSize:11, color:C.slate400 }}>Case: {p.case_number}</div>}
                </div>
              </div>
            ))
          }
        </Card>
      </div>
    </div>
  );
}

// ─── Upload ───────────────────────────────────────────────────────────────────
function Upload({ patients, onRefresh }) {
  const { queue, addFiles, removeFile, clearDone, uploadAll, stopUpload, running, folder, setFolder } = useUpload();
  const [dragActive, setDragActive] = useState(false);
  const [defaults, setDefaults]     = useState({ patient:"", caseNum:"", category:"Medical Records" });
  const fileInputRef = useRef();

  const existingFolders = [...new Set(patients.map(p=>p.case_number).filter(Boolean))];

  const handleDrop = e => {
    e.preventDefault(); setDragActive(false);
    addFiles(e.dataTransfer.files, defaults);
  };

  const hasPending    = queue.some(f=>f.status==="pending");
  const allDone       = queue.length>0 && queue.every(f=>["completed","error","cancelled"].includes(f.status));
  const duplicateFiles = queue.filter(f=>f.isDuplicate && f.status==="completed");

  const getIcon = type => type?.startsWith("image/") ? "🖼️" : type?.includes("zip") ? "🗜️" : "📄";

  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Upload Documents</h1>
          <p style={{ color:C.slate600, marginTop:4 }}>Upload medical and legal documents in any format</p>
        </div>
      </div>

      {/* Folder / case */}
      <Card style={{ marginBottom:20, background:C.blue50, border:`2px solid #bfdbfe` }}>
        <div style={{ marginBottom:12, fontSize:14, fontWeight:600, color:C.slate700, display:"flex", alignItems:"center", gap:8 }}>
          📁 Folder / Case Assignment
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12 }}>
          <FInput label="Patient Name" value={defaults.patient} onChange={v=>setDefaults(d=>({...d,patient:v}))} placeholder="e.g. Jane Smith" style={{margin:0}} />
          <FInput label="Case Number" value={defaults.caseNum} onChange={v=>setDefaults(d=>({...d,caseNum:v}))} placeholder="e.g. 4A2505HTQH00001" style={{margin:0}} />
          <div style={{ marginBottom:0 }}>
            <label style={{ display:"block", fontSize:13, fontWeight:500, color:C.slate700, marginBottom:5 }}>Folder</label>
            <input list="folders" value={folder} onChange={e=>setFolder(e.target.value)} placeholder="Type or select folder…" style={inp} />
            <datalist id="folders">{existingFolders.map(f=><option key={f} value={f}/>)}</datalist>
          </div>
          <FSelect label="Category" value={defaults.category} onChange={v=>setDefaults(d=>({...d,category:v}))} options={CATEGORIES} />
        </div>
      </Card>

      {/* Drop zone */}
      <Card
        style={{ marginBottom:20, border:`2px dashed ${dragActive?"#2563eb":C.slate200}`, background:dragActive?C.blue50:"#fff", cursor:"pointer", textAlign:"center" }}
        onDragOver={e=>{e.preventDefault();setDragActive(true);}}
        onDragLeave={()=>setDragActive(false)}
        onDrop={handleDrop}
        onClick={()=>fileInputRef.current.click()}
      >
        <div style={{ padding:"32px 20px" }}>
          <div style={{ fontSize:40, marginBottom:10 }}>📂</div>
          <div style={{ fontSize:16, fontWeight:600, color:C.slate700, marginBottom:4 }}>Drop files here or click to browse</div>
          <div style={{ fontSize:13, color:C.slate400 }}>PDF, JPG, PNG, TIFF — multiple files supported, max 500MB each</div>
        </div>
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tiff" style={{ display:"none" }} onChange={e=>addFiles(e.target.files, defaults)} />
      </Card>

      {/* Controls */}
      {queue.length > 0 && (
        <div style={{ display:"flex", gap:10, marginBottom:16, alignItems:"center" }}>
          {!allDone && !running && hasPending && <Btn onClick={uploadAll}>⬆ Upload {queue.filter(f=>f.status==="pending").length} File{queue.filter(f=>f.status==="pending").length!==1?"s":""}</Btn>}
          {running && <Btn onClick={stopUpload} variant="danger">⏹ Stop Upload</Btn>}
          {allDone && <Btn onClick={()=>{clearDone();onRefresh();}} variant="secondary">✓ Clear & Refresh</Btn>}
          {duplicateFiles.length > 0 && (
            <Badge color={C.amber600} bg="#fef3c7">⚠ {duplicateFiles.length} Duplicate{duplicateFiles.length!==1?"s":""} Detected</Badge>
          )}
        </div>
      )}

      {/* File Queue */}
      {queue.length === 0 ? (
        <Empty icon="📁" title="No files added yet" sub="Drag and drop files above or click to browse" />
      ) : (
        <div style={{ display:"grid", gap:8 }}>
          {queue.map(item => (
            <Card key={item.id} style={{ display:"flex", alignItems:"center", gap:12, background: item.status==="completed"?C.green50 : item.status==="error"?"#fef2f2" : item.isDuplicate?"#fffbeb":"#fff" }}>
              <span style={{ fontSize:22, flexShrink:0 }}>{getIcon(item.file.type)}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:500, color:C.slate900, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.file.name}</div>
                <div style={{ fontSize:12, color:C.slate400, marginTop:2, display:"flex", gap:10 }}>
                  <span>{(item.file.size/1024/1024).toFixed(2)} MB</span>
                  {item.patient && <span>👤 {item.patient}</span>}
                  {item.folder && <span>📁 {item.folder}</span>}
                  {item.isDuplicate && <Badge color={C.amber600} bg="#fef3c7">Duplicate</Badge>}
                  {item.hasDuplicatePages && <Badge color={C.amber600} bg="#fef3c7">⚠ Dup Pages</Badge>}
                </div>
                {item.status==="error" && <div style={{ fontSize:11.5, color:C.red600, marginTop:3 }}>✗ {item.error}</div>}
                {item.status==="uploading" && <Progress value={50} />}
              </div>
              <div style={{ flexShrink:0 }}>
                {item.status==="pending"    && <Badge color={C.slate500} bg={C.slate100}>Queued</Badge>}
                {item.status==="uploading"  && <Badge color={C.amber600} bg="#fef3c7">Uploading…</Badge>}
                {item.status==="completed"  && <Badge color={C.green600} bg="#dcfce7">✓ Done</Badge>}
                {item.status==="error"      && <Badge color={C.red600}   bg="#fee2e2">Failed</Badge>}
                {item.status==="cancelled"  && <Badge color={C.slate500} bg={C.slate100}>Cancelled</Badge>}
              </div>
              {item.status!=="uploading" && <button onClick={()=>removeFile(item.id)} style={{ background:"none", border:"none", cursor:"pointer", color:C.slate400, fontSize:16 }}>✕</button>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Document Library ─────────────────────────────────────────────────────────
function Library({ documents, onRefresh }) {
  const [search,      setSearch]      = useState("");
  const [catFilter,   setCatFilter]   = useState("all");
  const [viewMode,    setViewMode]    = useState("date");    // date | folder
  const [folderView,  setFolderView]  = useState(null);     // null = folder list, string = folder name
  const [selected,    setSelected]    = useState(new Set());
  const [viewDoc,     setViewDoc]     = useState(null);
  const [deleteDialog,setDeleteDialog]= useState(null);
  const [processing,  setProcessing]  = useState({});
  const [editFolderDoc, setEditFolderDoc] = useState(null);
  const [newFolder, setNewFolder] = useState("");

  const folders = [...new Set(documents.map(d=>d.folder).filter(Boolean))].sort();

  const filtered = documents.filter(d => {
    const q = search.toLowerCase();
    if (search && !`${d.title||""} ${d.patient_name||""} ${d.provider_name||""} ${d.case_number||""} ${d.folder||""}`.toLowerCase().includes(q)) return false;
    if (catFilter !== "all" && (d.category||"").toLowerCase() !== catFilter) return false;
    return true;
  });

  const grouped = filtered.reduce((acc, d) => {
    if (viewMode === "folder") {
      const k = d.folder || "Unfiled";
      if (!acc[k]) acc[k] = [];
      acc[k].push(d);
    } else {
      const k = new Date(d.created_at||d.document_date||0).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) || "Unknown Date";
      if (!acc[k]) acc[k] = [];
      acc[k].push(d);
    }
    return acc;
  }, {});

  const toggleSel = id => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const selAll    = () => setSelected(new Set(filtered.map(d=>d.aws_document_id)));
  const deselAll  = () => setSelected(new Set());

  const processDoc = async doc => {
    setProcessing(p=>({...p,[doc.aws_document_id]:true}));
    try {
      const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      alert("✅ AI processing complete!\n\n" + (res.summary ? res.summary.substring(0,400)+"…" : "Summary saved."));
      onRefresh();
    } catch(e) { alert("Processing failed: "+e.message); }
    setProcessing(p=>({...p,[doc.aws_document_id]:false}));
  };

  const deleteDoc = async id => {
    try { await awsDel(`/documents/${id}`); onRefresh(); setDeleteDialog(null); }
    catch(e) { alert(e.message); }
  };

  const deleteSelected = async () => {
    if (!confirm(`Delete ${selected.size} document${selected.size!==1?"s":""}?`)) return;
    await Promise.all([...selected].map(id => awsDel(`/documents/${id}`).catch(()=>{})));
    setSelected(new Set()); onRefresh();
  };

  const updateFolder = async (doc, f) => {
    try { await awsPut(`/documents/${doc.aws_document_id}`, { folder: f }); onRefresh(); setEditFolderDoc(null); }
    catch(e) { alert(e.message); }
  };

  const DocRow = ({ doc }) => (
    <Card style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", marginBottom:8 }}>
      <input type="checkbox" checked={selected.has(doc.aws_document_id)} onChange={()=>toggleSel(doc.aws_document_id)} style={{ flexShrink:0 }} />
      <span style={{ fontSize:20, flexShrink:0 }}>📄</span>
      <div style={{ flex:1, minWidth:0, cursor:"pointer" }} onClick={()=>setViewDoc(doc)}>
        <div style={{ fontSize:13.5, fontWeight:500, color:C.slate900, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {doc.title||doc.file_name}
          {doc.is_duplicate && <Badge color={C.amber600} bg="#fef3c7" style={{marginLeft:8}}>Duplicate</Badge>}
          {doc.has_duplicate_pages && <Badge color={C.amber600} bg="#fef3c7" style={{marginLeft:4}}>⚠ Dup Pages</Badge>}
          {doc.is_rejected && <Badge color={C.red600} bg="#fee2e2" style={{marginLeft:4}}>Rejected</Badge>}
        </div>
        <div style={{ fontSize:12, color:C.slate400, marginTop:2, display:"flex", gap:10, flexWrap:"wrap" }}>
          {doc.patient_name  && <span>👤 {doc.patient_name}</span>}
          {doc.provider_name && <span>🏥 {doc.provider_name}</span>}
          {doc.document_date && <span>📅 {doc.document_date}</span>}
          {doc.page_count    && <span>📃 {doc.page_count}pp</span>}
          {doc.folder        && <span>📁 {doc.folder}</span>}
          {doc.category      && <Badge color={C.blue600} bg={C.blue50}>{doc.category}</Badge>}
        </div>
      </div>
      <div style={{ display:"flex", gap:6, flexShrink:0 }}>
        <StatusBadge status={doc.status} />
        {!["completed","processed"].includes(doc.status) && (
          <Btn onClick={()=>processDoc(doc)} variant="outline" size="sm" disabled={processing[doc.aws_document_id]}>
            {processing[doc.aws_document_id]?"…":"⚡ Scan"}
          </Btn>
        )}
        <Btn onClick={()=>setEditFolderDoc(doc)} variant="outline" size="sm">📁</Btn>
        <Btn onClick={async()=>{
          try { const r = await awsGet(`/documents/${doc.aws_document_id}/download-url`); window.open(r.download_url,"_blank"); }
          catch(e) { alert(e.message); }
        }} variant="outline" size="sm">⬇</Btn>
        <Btn onClick={()=>setDeleteDialog(doc)} variant="ghost" size="sm" style={{color:C.red600}}>🗑</Btn>
      </div>
    </Card>
  );

  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Document Library</h1>
          <p style={{ color:C.slate600, marginTop:4 }}>{documents.length} document{documents.length!==1?"s":""} total</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {selected.size>0 && <Btn onClick={deleteSelected} variant="danger" size="sm">🗑 Delete ({selected.size})</Btn>}
          <Btn onClick={onRefresh} variant="outline" size="sm">↻ Refresh</Btn>
        </div>
      </div>

      {/* Filters */}
      <Card style={{ marginBottom:16, padding:"12px 16px" }}>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search documents, patients, providers…" style={{ ...inp, flex:1, minWidth:200 }} />
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
            <option value="all">All Categories</option>
            {["medical","legal","imaging","other"].map(c=><option key={c} value={c}>{c[0].toUpperCase()+c.slice(1)}</option>)}
          </select>
          <div style={{ display:"flex", gap:4 }}>
            {["date","folder"].map(m=>(
              <button key={m} onClick={()=>setViewMode(m)} style={{ padding:"7px 12px", borderRadius:7, border:"none", cursor:"pointer", fontSize:13, fontWeight:viewMode===m?600:400, background:viewMode===m?C.blue600:"#f1f5f9", color:viewMode===m?"#fff":C.slate600 }}>
                {m==="date"?"📅 Date":"📁 Folder"}
              </button>
            ))}
          </div>
          {selected.size>0
            ? <Btn onClick={deselAll} variant="outline" size="sm">Deselect All</Btn>
            : filtered.length>0 && <Btn onClick={selAll} variant="outline" size="sm">Select All</Btn>
          }
        </div>
      </Card>

      {documents.length===0 ? (
        <Empty icon="📚" title="No documents yet" sub="Upload some documents to get started" />
      ) : filtered.length===0 ? (
        <Empty icon="🔍" title="No documents match your filters" />
      ) : viewMode==="folder" ? (
        Object.entries(grouped).map(([f, docs]) => (
          <div key={f} style={{ marginBottom:24 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, padding:"8px 12px", background:C.slate50, borderRadius:8, border:`1px solid ${C.slate200}` }}>
              <span style={{ fontSize:16 }}>📁</span>
              <span style={{ fontWeight:700, fontSize:15, color:C.slate900 }}>{f}</span>
              <Badge color={C.slate500} bg={C.slate100}>{docs.length}</Badge>
            </div>
            {docs.map(d=><DocRow key={d.aws_document_id} doc={d} />)}
          </div>
        ))
      ) : (
        Object.entries(grouped).map(([date, docs]) => (
          <div key={date} style={{ marginBottom:20 }}>
            <div style={{ fontSize:13, fontWeight:600, color:C.slate500, marginBottom:8, textTransform:"uppercase", letterSpacing:"0.5px" }}>{date}</div>
            {docs.map(d=><DocRow key={d.aws_document_id} doc={d} />)}
          </div>
        ))
      )}

      {/* Edit Folder Modal */}
      {editFolderDoc && (
        <Modal title="Move to Folder" onClose={()=>setEditFolderDoc(null)}>
          <FInput label="Folder Name" value={newFolder} onChange={setNewFolder} placeholder="e.g. Case 2025-001" />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setEditFolderDoc(null)} variant="outline">Cancel</Btn>
            <Btn onClick={()=>updateFolder(editFolderDoc, newFolder)}>Move</Btn>
          </div>
        </Modal>
      )}

      {/* View Doc Modal */}
      {viewDoc && (
        <Modal title={viewDoc.title||viewDoc.file_name} description={`Patient: ${viewDoc.patient_name||"—"} · ${viewDoc.case_number||""}`} onClose={()=>setViewDoc(null)} width={700}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:16 }}>
            {[["Status",<StatusBadge status={viewDoc.status}/>],["Category",viewDoc.category||"—"],["Pages",viewDoc.page_count||"—"],["Date",viewDoc.document_date||"—"],["Provider",viewDoc.provider_name||"—"],["Folder",viewDoc.folder||"—"]].map(([l,v])=>(
              <div key={l} style={{ background:C.slate50, borderRadius:7, padding:"9px 12px" }}>
                <div style={{ fontSize:10.5, color:C.slate400, fontWeight:700, textTransform:"uppercase", marginBottom:2 }}>{l}</div>
                <div style={{ fontSize:13, fontWeight:500, color:C.slate700 }}>{v}</div>
              </div>
            ))}
          </div>
          {viewDoc.has_duplicate_pages && viewDoc.duplicate_pages?.length>0 && (
            <div style={{ background:C.amber50, border:`1px solid ${C.amber200}`, borderRadius:8, padding:"12px 14px", marginBottom:14 }}>
              <div style={{ fontWeight:700, fontSize:13, color:"#92400e", marginBottom:6 }}>⚠ Duplicate Pages Detected</div>
              {viewDoc.duplicate_pages.slice(0,4).map((dp,i)=>(
                <div key={i} style={{ fontSize:12, color:"#78350f", marginBottom:3 }}>Pages {(dp.page_numbers||[]).join(", ")}: {dp.similarity}</div>
              ))}
            </div>
          )}
          {viewDoc.notes && <div style={{ background:C.slate50, borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13, color:C.slate600, lineHeight:1.6 }}>{viewDoc.notes}</div>}
          <div style={{ display:"flex", gap:8 }}>
            {!["completed","processed"].includes(viewDoc.status) && <Btn onClick={()=>{processDoc(viewDoc);setViewDoc(null);}} variant="success">⚡ AI Scan</Btn>}
            <Btn onClick={async()=>{ try { const r=await awsGet(`/documents/${viewDoc.aws_document_id}/download-url`); window.open(r.download_url,"_blank"); } catch(e){alert(e.message);} }} variant="outline">⬇ Download</Btn>
          </div>
        </Modal>
      )}

      {deleteDialog && (
        <AlertDialog title="Delete Document" description={`Are you sure you want to delete "${deleteDialog.title||deleteDialog.file_name}"? This cannot be undone.`}
          onConfirm={()=>deleteDoc(deleteDialog.aws_document_id)} onCancel={()=>setDeleteDialog(null)} confirmLabel="Delete" danger />
      )}
    </div>
  );
}

// ─── Duplicate Manager ────────────────────────────────────────────────────────
function Duplicates({ documents, onRefresh }) {
  const [selected, setSelected] = useState(new Set());
  const [deleteDialog, setDeleteDialog] = useState(false);

  const dupeGroups = {};
  documents.forEach(doc => {
    if (doc.is_duplicate && doc.duplicate_of) {
      if (!dupeGroups[doc.duplicate_of]) {
        const orig = documents.find(d=>d.aws_document_id===doc.duplicate_of);
        if (orig) dupeGroups[doc.duplicate_of] = { original:orig, duplicates:[] };
      }
      if (dupeGroups[doc.duplicate_of]) dupeGroups[doc.duplicate_of].duplicates.push(doc);
    }
  });
  const groups = Object.values(dupeGroups);
  const allDupeIds = groups.flatMap(g=>g.duplicates.map(d=>d.aws_document_id));

  const toggle = id => setSelected(s=>{ const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const selAll  = () => setSelected(new Set(allDupeIds));
  const desel   = () => setSelected(new Set());

  const deleteSelected = async () => {
    await Promise.all([...selected].map(id=>awsDel(`/documents/${id}`).catch(()=>{})));
    setSelected(new Set()); setDeleteDialog(false); onRefresh();
  };

  const wasted = documents.filter(d=>d.is_duplicate).reduce((s,d)=>s+(d.file_size||0),0);

  return (
    <div style={{ padding:32 }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Duplicate Manager</h1>
        <p style={{ color:C.slate600, marginTop:4 }}>Review and manage duplicate documents</p>
      </div>

      <Card style={{ background:`linear-gradient(135deg,${C.amber50},#fff7ed)`, border:`1px solid ${C.amber200}`, marginBottom:20 }}>
        <div style={{ fontSize:15, fontWeight:700, color:"#92400e", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>⚠️ Duplicate Summary</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16 }}>
          {[["Total Duplicates",documents.filter(d=>d.is_duplicate).length],["Duplicate Groups",groups.length],["Storage Wasted",`${(wasted/1024/1024).toFixed(1)} MB`]].map(([l,v])=>(
            <div key={l}><div style={{ fontSize:12, color:"#92400e", marginBottom:2 }}>{l}</div><div style={{ fontSize:26, fontWeight:700, color:"#7c2d12" }}>{v}</div></div>
          ))}
        </div>
      </Card>

      {allDupeIds.length > 0 && (
        <Card style={{ marginBottom:16, background:C.blue50, border:`2px solid #bfdbfe` }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <Btn onClick={selected.size===allDupeIds.length?desel:selAll} variant="outline" size="sm">
                {selected.size===allDupeIds.length?"☑ Deselect All":"☐ Select All Duplicates"}
              </Btn>
              {selected.size>0 && <Badge color={C.blue600} bg="#dbeafe">{selected.size} selected</Badge>}
            </div>
            {selected.size>0 && <Btn onClick={()=>setDeleteDialog(true)} variant="danger" size="sm">🗑 Delete Selected ({selected.size})</Btn>}
          </div>
        </Card>
      )}

      {groups.length===0 ? (
        <Empty icon="✅" title="No duplicates found" sub="Your document library is clean!" />
      ) : groups.map((g, idx) => (
        <Card key={g.original.aws_document_id} style={{ marginBottom:20 }}>
          <div style={{ fontSize:15, fontWeight:700, color:C.slate900, marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
            📋 Duplicate Group {idx+1}
            <Badge color={C.amber600} bg="#fef3c7">{g.duplicates.length} duplicate{g.duplicates.length!==1?"s":""}</Badge>
          </div>

          {/* Original */}
          <div style={{ background:C.green50, border:`2px solid #86efac`, borderRadius:9, padding:14, marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span>✅</span><Badge color={C.green600} bg="#dcfce7">Original</Badge>
                </div>
                <div style={{ fontWeight:600, fontSize:14, marginBottom:4 }}>{g.original.title}</div>
                <div style={{ fontSize:12, color:C.slate500, display:"flex", gap:14 }}>
                  <span>Uploaded: {g.original.created_at ? new Date(g.original.created_at).toLocaleDateString() : "—"}</span>
                  {g.original.file_size && <span>Size: {(g.original.file_size/1024/1024).toFixed(2)} MB</span>}
                  {g.original.patient_name && <span>Patient: {g.original.patient_name}</span>}
                </div>
              </div>
              <Btn onClick={async()=>{ try { const r=await awsGet(`/documents/${g.original.aws_document_id}/download-url`); window.open(r.download_url,"_blank"); } catch(e){alert(e.message);} }} variant="outline" size="sm">⬇ View</Btn>
            </div>
          </div>

          {/* Duplicates */}
          {g.duplicates.map(dup => (
            <div key={dup.aws_document_id} style={{ background:"#fefce8", border:`1px solid #fde047`, borderRadius:9, padding:14, marginBottom:8, display:"flex", alignItems:"center", gap:12 }}>
              <input type="checkbox" checked={selected.has(dup.aws_document_id)} onChange={()=>toggle(dup.aws_document_id)} />
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:500, fontSize:14 }}>{dup.title}</div>
                <div style={{ fontSize:12, color:C.slate500, display:"flex", gap:14 }}>
                  <span>Uploaded: {dup.created_at ? new Date(dup.created_at).toLocaleDateString() : "—"}</span>
                  {dup.file_size && <span>Size: {(dup.file_size/1024/1024).toFixed(2)} MB</span>}
                </div>
              </div>
              <Btn onClick={()=>{ setSelected(new Set([dup.aws_document_id])); setDeleteDialog(true); }} variant="danger" size="sm">🗑 Delete</Btn>
            </div>
          ))}
        </Card>
      ))}

      {deleteDialog && (
        <AlertDialog title="Delete Duplicates" description={`Delete ${selected.size} duplicate document${selected.size!==1?"s":""}? Originals will be kept. This cannot be undone.`}
          onConfirm={deleteSelected} onCancel={()=>setDeleteDialog(false)} confirmLabel={`Delete ${selected.size}`} danger />
      )}
    </div>
  );
}

// ─── Medical Summaries ────────────────────────────────────────────────────────
function MedicalSummaries({ summaries, patients, documents, onRefresh }) {
  const [viewing,   setViewing]   = useState(null);
  const [creating,  setCreating]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [search,    setSearch]    = useState("");
  const [delDlg,    setDelDlg]    = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [selDocs,   setSelDocs]   = useState([]);
  const [form, setForm] = useState({ patient_id:"", header_note:"", ime_note:"", chart_review_note:"", discussion_note:"", physical_examination_note:"", footer_note:"" });

  const filtered = summaries.filter(s => !search || `${s.patient_name||""} ${s.case_number||""}`.toLowerCase().includes(search.toLowerCase()));

  const folders = [...new Set(documents.map(d=>d.folder).filter(Boolean))].sort();

  const reset = () => { setForm({ patient_id:"", header_note:"", ime_note:"", chart_review_note:"", discussion_note:"", physical_examination_note:"", footer_note:"" }); setSelDocs([]); };

  const openCreate = () => { reset(); setEditing(null); setCreating(true); };
  const openEdit   = s  => { setEditing(s); setForm({ patient_id:s.aws_patient_id||"", header_note:s.header_note||"", ime_note:s.ime_note||"", chart_review_note:s.chart_review_note||"", discussion_note:s.discussion_note||"", physical_examination_note:s.physical_examination_note||"", footer_note:s.footer_note||"" }); setCreating(true); };

  const save = async () => {
    if (!form.patient_id && !editing) return alert("Select a patient.");
    setSaving(true);
    try {
      const payload = { ...form, document_ids: selDocs };
      if (editing) await awsPut(`/summaries/${editing.aws_summary_id}`, payload);
      else          await awsPost("/summaries", payload);
      setCreating(false); reset(); onRefresh();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const del = async id => {
    try { await awsDel(`/summaries/${id}`); onRefresh(); setDelDlg(null); } catch(e) { alert(e.message); }
  };

  const dedupeVisits = visits => {
    const seen = new Set();
    return (visits||[]).filter(v => {
      const k = `${v.visit_date||""}|${v.rendering_provider||""}|${v.practice_setting||""}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };

  const pc = p => p==="improved" ? {color:C.green600,bg:"#dcfce7"} : p==="worse" ? {color:C.red600,bg:"#fee2e2"} : {color:C.slate500,bg:C.slate100};

  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Medical Summaries</h1>
          <p style={{ color:C.slate600, marginTop:4 }}>{summaries.length} summar{summaries.length!==1?"ies":"y"}</p>
        </div>
        <Btn onClick={openCreate}>+ New Summary</Btn>
      </div>

      <Card style={{ marginBottom:16, padding:"12px 16px" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by patient or case…" style={{ ...inp, border:"none", outline:"none", background:"transparent" }} />
      </Card>

      {summaries.length===0 ? (
        <Empty icon="✅" title="No summaries yet" sub="Create a summary to document a patient's visit history" action={<Btn onClick={openCreate}>Create Summary</Btn>} />
      ) : filtered.length===0 ? <Empty icon="🔍" title="No summaries match your search" /> : (
        <div style={{ display:"grid", gap:10 }}>
          {filtered.map(s => (
            <Card key={s.aws_summary_id} style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
              <div style={{ width:44, height:44, borderRadius:10, background:"#ede9fe", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>✅</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.slate900, marginBottom:3 }}>{s.patient_name||"Unknown Patient"}</div>
                <div style={{ fontSize:12, color:C.slate500, marginBottom:5 }}>
                  {s.case_number && <span style={{marginRight:10}}>📁 {s.case_number}</span>}
                  {s.visits?.length>0 && <span>{s.visits.length} visit{s.visits.length!==1?"s":""}</span>}
                </div>
                {s.header_note && <div style={{ fontSize:13, color:C.slate600, lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{s.header_note}</div>}
              </div>
              <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                <Btn onClick={()=>setViewing(s)} variant="outline" size="sm">👁 View</Btn>
                <Btn onClick={()=>openEdit(s)} variant="outline" size="sm">✏️ Edit</Btn>
                <Btn onClick={()=>{ const deduped=dedupeVisits(s.visits); const removed=(s.visits||[]).length-deduped.length; if(!removed){alert("No duplicate visits found.");return;} awsPut(`/summaries/${s.aws_summary_id}`,{visits:deduped}).then(()=>{alert(`Removed ${removed} duplicate visit(s).`);onRefresh();}).catch(e=>alert(e.message)); }} variant="outline" size="sm" title="Remove duplicate visits">🔀</Btn>
                <Btn onClick={()=>setDelDlg(s)} variant="ghost" size="sm" style={{color:C.red600}}>🗑</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Summary Viewer */}
      {viewing && (
        <Modal title={`Summary — ${viewing.patient_name||"Patient"}`} description={viewing.case_number?`Case: ${viewing.case_number}`:undefined} onClose={()=>setViewing(null)} width={900}>
          {viewing.header_note && (
            <div style={{ background:C.slate50, borderRadius:8, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:C.slate400, textTransform:"uppercase", marginBottom:5 }}>Header Note</div>
              <div style={{ fontSize:13.5, color:C.slate700, lineHeight:1.7, whiteSpace:"pre-line" }}>{viewing.header_note}</div>
            </div>
          )}
          {viewing.visits?.length>0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:14, fontWeight:700, color:C.slate900, marginBottom:10 }}>Visit Timeline — {viewing.visits.length} Visit{viewing.visits.length!==1?"s":""}</div>
              <div style={{ maxHeight:500, overflow:"auto", paddingRight:4 }}>
                {viewing.visits.map((v,i)=>{
                  const {color,bg} = pc(v.symptom_progression);
                  return (
                    <div key={i} style={{ background:C.slate50, borderRadius:9, padding:14, marginBottom:10, borderLeft:"3px solid #3b82f6" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                        <span style={{ fontSize:14, fontWeight:700, color:C.slate900 }}>{v.visit_date}</span>
                        <div style={{ display:"flex", gap:6 }}>
                          {(v.icd10_codes||[]).slice(0,2).map(c=><span key={c} style={{ fontSize:11, background:C.slate100, border:`1px solid ${C.slate200}`, borderRadius:4, padding:"1px 6px" }}>{c}</span>)}
                          {v.symptom_progression && v.symptom_progression!=="not_documented" && <Badge color={color} bg={bg}>{v.symptom_progression.replace(/_/g," ")}</Badge>}
                          {v.pain_scale && v.pain_scale!=="not_documented" && <Badge color={C.slate500} bg={C.slate100}>Pain: {v.pain_scale}</Badge>}
                        </div>
                      </div>
                      <div style={{ fontSize:12, color:C.slate500, marginBottom:8 }}>
                        {v.rendering_provider && <span style={{marginRight:12}}>👨‍⚕️ {v.rendering_provider}</span>}
                        {v.practice_setting   && <span>🏥 {v.practice_setting}</span>}
                      </div>
                      {v.hpi_summary && <div style={{ fontSize:13, color:C.slate700, marginBottom:6, lineHeight:1.6 }}><strong>HPI:</strong> {v.hpi_summary}</div>}
                      {v.impression_diagnosis && <div style={{ fontSize:13, color:C.slate700, marginBottom:6 }}><strong>Impression:</strong> {v.impression_diagnosis}</div>}
                      {v.physical_exam_findings && <details style={{marginTop:4}}><summary style={{fontSize:12,color:C.slate500,cursor:"pointer",fontWeight:500}}>Physical Exam ▸</summary><div style={{fontSize:12.5,color:C.slate600,lineHeight:1.6,marginTop:5,whiteSpace:"pre-line"}}>{v.physical_exam_findings}</div></details>}
                      {v.treatment_plan && <details style={{marginTop:4}}><summary style={{fontSize:12,color:C.slate500,cursor:"pointer",fontWeight:500}}>Treatment Plan ▸</summary><div style={{fontSize:12.5,color:C.slate600,lineHeight:1.6,marginTop:5}}>{v.treatment_plan}</div></details>}
                      {v.imaging_findings && <details style={{marginTop:4}}><summary style={{fontSize:12,color:C.slate500,cursor:"pointer",fontWeight:500}}>Imaging ▸</summary><div style={{fontSize:12.5,color:C.slate600,lineHeight:1.6,marginTop:5}}>{v.imaging_findings}</div></details>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {[["IME Note",viewing.ime_note],["Chart Review",viewing.chart_review_note],["Discussion",viewing.discussion_note],["Physical Examination",viewing.physical_examination_note],["Footer Note",viewing.footer_note]].filter(([,v])=>v).map(([l,v])=>(
            <div key={l} style={{ background:C.slate50, borderRadius:8, padding:14, marginBottom:10 }}>
              <div style={{ fontSize:10.5, fontWeight:700, color:C.slate400, textTransform:"uppercase", marginBottom:5 }}>{l}</div>
              <div style={{ fontSize:13.5, color:C.slate700, lineHeight:1.7, whiteSpace:"pre-line" }}>{v}</div>
            </div>
          ))}
        </Modal>
      )}

      {/* Create / Edit Modal */}
      {creating && (
        <Modal title={editing?"Edit Summary":"New Medical Summary"} onClose={()=>{setCreating(false);reset();}} width={680}>
          {!editing && (
            <FSelect label="Patient" value={form.patient_id} onChange={v=>setForm(f=>({...f,patient_id:v}))}
              options={[{value:"",label:"Select patient…"},...patients.map(p=>({value:p.aws_patient_id,label:p.patient_name}))]} />
          )}
          {folders.length>0 && !editing && (
            <div style={{ marginBottom:14 }}>
              <label style={{ display:"block", fontSize:13, fontWeight:500, color:C.slate700, marginBottom:5 }}>Select Documents (optional)</label>
              <div style={{ maxHeight:140, overflow:"auto", border:`1px solid ${C.slate200}`, borderRadius:8, padding:8 }}>
                {documents.map(d=>(
                  <label key={d.aws_document_id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0", cursor:"pointer", fontSize:13 }}>
                    <input type="checkbox" checked={selDocs.includes(d.aws_document_id)} onChange={()=>setSelDocs(s=>s.includes(d.aws_document_id)?s.filter(x=>x!==d.aws_document_id):[...s,d.aws_document_id])} />
                    {d.title||d.file_name} {d.folder&&<span style={{fontSize:11,color:C.slate400}}>({d.folder})</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
          <FTextarea label="Header Note" value={form.header_note} onChange={v=>setForm(f=>({...f,header_note:v}))} rows={4} placeholder="Introductory narrative…" />
          <FTextarea label="IME Note" value={form.ime_note} onChange={v=>setForm(f=>({...f,ime_note:v}))} rows={3} placeholder="Independent Medical Exam notes…" />
          <FTextarea label="Chart Review" value={form.chart_review_note} onChange={v=>setForm(f=>({...f,chart_review_note:v}))} rows={3} />
          <FTextarea label="Discussion" value={form.discussion_note} onChange={v=>setForm(f=>({...f,discussion_note:v}))} rows={3} />
          <FTextarea label="Physical Examination" value={form.physical_examination_note} onChange={v=>setForm(f=>({...f,physical_examination_note:v}))} rows={3} />
          <FTextarea label="Footer Note" value={form.footer_note} onChange={v=>setForm(f=>({...f,footer_note:v}))} rows={3} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>{setCreating(false);reset();}} variant="outline">Cancel</Btn>
            <Btn onClick={save} disabled={saving}>{saving?"Saving…":editing?"Save Changes":"Create Summary"}</Btn>
          </div>
        </Modal>
      )}

      {delDlg && (
        <AlertDialog title="Delete Summary" description={`Delete summary for ${delDlg.patient_name||"this patient"}? Cannot be undone.`}
          onConfirm={()=>del(delDlg.aws_summary_id)} onCancel={()=>setDelDlg(null)} confirmLabel="Delete" danger />
      )}
    </div>
  );
}

// ─── Settings (Notes Macros + Export) ────────────────────────────────────────
function Settings() {
  const [macros, setMacros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name:"", content:"", section:"" });
  const [copiedId, setCopiedId] = useState(null);
  const [font, setFont] = useState("Calibri");
  const [fontSize, setFontSize] = useState(11);

  const load = useCallback(async () => {
    setLoading(true);
    try { setMacros(await NotesMacro.list()); } catch(e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const sections = ["all", ...new Set(macros.map(m=>m.section).filter(Boolean))];
  const filtered = macros.filter(m => {
    if (sectionFilter!=="all" && m.section!==sectionFilter) return false;
    if (search && !`${m.name} ${m.section||""} ${m.content}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openNew  = ()  => { setEditing(null); setForm({name:"",content:"",section:""}); setShowModal(true); };
  const openEdit = m   => { setEditing(m); setForm({name:m.name||"",content:m.content||"",section:m.section||""}); setShowModal(true); };
  const save = async () => {
    if (!form.name.trim()) return alert("Name required.");
    try {
      if (editing) await NotesMacro.update(editing.id, form);
      else await NotesMacro.create(form);
      setShowModal(false); load();
    } catch(e) { alert(e.message); }
  };
  const del = async m => {
    if (!confirm(`Delete "${m.name}"?`)) return;
    try { await NotesMacro.delete(m.id); load(); } catch(e) { alert(e.message); }
  };
  const copy = m => {
    navigator.clipboard?.writeText(m.content);
    setCopiedId(m.id); setTimeout(()=>setCopiedId(null), 2000);
  };

  return (
    <div style={{ padding:32 }}>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Settings</h1>
        <p style={{ color:C.slate600, marginTop:4 }}>Customize your export preferences and manage macros</p>
      </div>

      {/* Export Settings */}
      <Card style={{ marginBottom:24 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.slate900, marginBottom:16, display:"flex", alignItems:"center", gap:8 }}>📄 Word Export Settings</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
          <FSelect label="Font Family" value={font} onChange={setFont} options={["Calibri","Arial","Times New Roman","Georgia","Verdana"]} />
          <FSelect label="Font Size" value={String(fontSize)} onChange={v=>setFontSize(+v)} options={[9,10,11,12,13,14,16].map(n=>({value:String(n),label:`${n} pt`}))} />
        </div>
        <div style={{ border:`1px solid ${C.slate200}`, borderRadius:8, padding:14, background:C.white }}>
          <div style={{ fontSize:12, color:C.slate500, marginBottom:6 }}>Preview</div>
          <p style={{ margin:0, fontFamily:font, fontSize:`${fontSize}pt`, color:C.slate700 }}>This is how your exported medical summaries will look. The quick brown fox jumps over the lazy dog.</p>
        </div>
      </Card>

      {/* Notes Macros */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:16, fontWeight:700, color:C.slate900 }}>📝 Notes Macros</div>
          <Btn onClick={openNew} size="sm">+ New Macro</Btn>
        </div>
        <div style={{ display:"flex", gap:10, marginBottom:14 }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search macros…" style={{ ...inp, flex:1 }} />
          {sections.length>1 && (
            <select value={sectionFilter} onChange={e=>setSectionFilter(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
              {sections.map(s=><option key={s} value={s}>{s==="all"?"All Sections":s}</option>)}
            </select>
          )}
        </div>
        {loading ? <Spinner /> : filtered.length===0 ? (
          <Empty icon="📝" title="No macros yet" action={<Btn onClick={openNew} size="sm">Create First Macro</Btn>} />
        ) : (
          <div style={{ display:"grid", gap:8 }}>
            {filtered.map(m=>(
              <div key={m.id} style={{ display:"flex", gap:12, padding:"12px 0", borderBottom:`1px solid ${C.slate100}` }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontWeight:600, fontSize:14, color:C.slate900 }}>{m.name}</span>
                    {m.section && <Badge color="#6d28d9" bg="#ede9fe">{m.section}</Badge>}
                  </div>
                  <div style={{ fontSize:13, color:C.slate500, lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{m.content}</div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  <Btn onClick={()=>copy(m)} variant="outline" size="sm">{copiedId===m.id?"✓ Copied":"Copy"}</Btn>
                  <Btn onClick={()=>openEdit(m)} variant="outline" size="sm">Edit</Btn>
                  <Btn onClick={()=>del(m)} variant="ghost" size="sm" style={{color:C.red600}}>Del</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showModal && (
        <Modal title={editing?"Edit Macro":"New Macro"} onClose={()=>setShowModal(false)}>
          <FInput label="Name" required value={form.name} onChange={v=>setForm(f=>({...f,name:v}))} placeholder="e.g. Normal Gait Exam" />
          <FInput label="Section" value={form.section} onChange={v=>setForm(f=>({...f,section:v}))} placeholder="e.g. Physical Exam, HPI, Assessment" />
          <FTextarea label="Content" value={form.content} onChange={v=>setForm(f=>({...f,content:v}))} rows={8} placeholder="Enter macro text…" />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowModal(false)} variant="outline">Cancel</Btn>
            <Btn onClick={save}>{editing?"Save Changes":"Create Macro"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Breach Notifications ────────────────────────────────────────────────────
function BreachNotifications() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ event_type:"", severity:"medium", description:"", affected_users:"", investigation_notes:"", status:"open" });

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await BreachNotification.list()); } catch(e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.description.trim()) return alert("Description required.");
    try { await BreachNotification.create({...form, detected_date:new Date().toISOString(), notification_sent:false}); setShowModal(false); setForm({event_type:"",severity:"medium",description:"",affected_users:"",investigation_notes:"",status:"open"}); load(); }
    catch(e) { alert(e.message); }
  };

  const toggle = async b => {
    try { await BreachNotification.update(b.id, { status: b.status==="resolved"?"open":"resolved" }); load(); } catch(e) { alert(e.message); }
  };

  const sevColors = { low:[C.green600,"#dcfce7"], medium:[C.amber600,"#fef3c7"], high:[C.red600,"#fee2e2"], critical:["#7f1d1d","#fce7f3"] };

  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Breach Notifications</h1>
          <p style={{ color:C.slate600, marginTop:4 }}>HIPAA security incident log</p>
        </div>
        <Btn onClick={()=>setShowModal(true)} variant="danger">+ Report Breach</Btn>
      </div>

      {loading ? <Spinner /> : items.length===0 ? (
        <Empty icon="🔒" title="No breach events logged" sub="All clear — no security incidents on record" />
      ) : (
        <div style={{ display:"grid", gap:10 }}>
          {items.map(b=>{
            const [color, bg] = sevColors[b.severity]||sevColors.medium;
            return (
              <Card key={b.id} style={{ display:"flex", gap:12, borderLeft:`4px solid ${color}` }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", gap:8, marginBottom:6, alignItems:"center" }}>
                    <span style={{ fontWeight:600, fontSize:14 }}>{b.event_type||"Security Event"}</span>
                    <Badge color={color} bg={bg}>{b.severity||"medium"}</Badge>
                    <StatusBadge status={b.status||"open"} />
                  </div>
                  <div style={{ fontSize:13, color:C.slate600, marginBottom:4 }}>{b.description}</div>
                  <div style={{ fontSize:11.5, color:C.slate400 }}>
                    {b.affected_users && <span style={{marginRight:10}}>Affected: {b.affected_users}</span>}
                    {b.detected_date  && <span>Detected: {new Date(b.detected_date).toLocaleString()}</span>}
                  </div>
                  {b.investigation_notes && <div style={{ fontSize:12, color:C.slate500, marginTop:4, fontStyle:"italic" }}>Notes: {b.investigation_notes}</div>}
                </div>
                <Btn onClick={()=>toggle(b)} variant={b.status==="resolved"?"outline":"success"} size="sm">
                  {b.status==="resolved"?"Reopen":"Resolve"}
                </Btn>
              </Card>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal title="Report Security Breach" description="Logged for HIPAA compliance" onClose={()=>setShowModal(false)}>
          <FInput label="Event Type" value={form.event_type} onChange={v=>setForm(f=>({...f,event_type:v}))} placeholder="e.g. Unauthorized Access, Data Exposure" />
          <FSelect label="Severity" value={form.severity} onChange={v=>setForm(f=>({...f,severity:v}))} options={["low","medium","high","critical"]} />
          <FTextarea label="Description" value={form.description} onChange={v=>setForm(f=>({...f,description:v}))} rows={4} />
          <FInput label="Affected Users / Records" value={form.affected_users} onChange={v=>setForm(f=>({...f,affected_users:v}))} placeholder="e.g. 0 identified" />
          <FTextarea label="Investigation Notes" value={form.investigation_notes} onChange={v=>setForm(f=>({...f,investigation_notes:v}))} rows={3} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowModal(false)} variant="outline">Cancel</Btn>
            <Btn onClick={save} variant="danger">Submit Report</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Suggestions ──────────────────────────────────────────────────────────────
function Suggestions() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ title:"", description:"", category:"Feature Request", priority:"medium" });

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await Suggestion.list()); } catch(e) { console.error(e); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.title.trim()) return alert("Title required.");
    try { await Suggestion.create(form); setShowModal(false); setForm({title:"",description:"",category:"Feature Request",priority:"medium"}); load(); }
    catch(e) { alert(e.message); }
  };

  const updateStatus = async (sg, status) => {
    try { await Suggestion.update(sg.id, { status }); load(); } catch(e) { alert(e.message); }
  };

  const prioColor = { low:[C.green600,"#dcfce7"], medium:[C.amber600,"#fef3c7"], high:[C.red600,"#fee2e2"] };

  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:0 }}>Suggestions</h1>
          <p style={{ color:C.slate600, marginTop:4 }}>Feature requests and feedback</p>
        </div>
        <Btn onClick={()=>setShowModal(true)}>+ Add Suggestion</Btn>
      </div>

      {loading ? <Spinner /> : items.length===0 ? (
        <Empty icon="💬" title="No suggestions yet" action={<Btn onClick={()=>setShowModal(true)}>Submit First Suggestion</Btn>} />
      ) : (
        <div style={{ display:"grid", gap:10 }}>
          {items.map(sg=>{
            const [pc, pbg] = prioColor[sg.priority]||prioColor.medium;
            return (
              <Card key={sg.id} style={{ display:"flex", gap:12 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", gap:8, marginBottom:4, alignItems:"center" }}>
                    <span style={{ fontWeight:600, fontSize:14 }}>{sg.title}</span>
                    {sg.category && <Badge color={C.slate500} bg={C.slate100}>{sg.category}</Badge>}
                    {sg.priority && <Badge color={pc} bg={pbg}>{sg.priority}</Badge>}
                  </div>
                  {sg.description && <div style={{ fontSize:13, color:C.slate500 }}>{sg.description}</div>}
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                  <StatusBadge status={sg.status||"pending"} />
                  <select value={sg.status||"pending"} onChange={e=>updateStatus(sg,e.target.value)} style={{ ...inp, width:120, fontSize:12 }}>
                    {["pending","reviewing","planned","completed","rejected"].map(v=><option key={v}>{v}</option>)}
                  </select>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal title="Add Suggestion" onClose={()=>setShowModal(false)}>
          <FInput label="Title" required value={form.title} onChange={v=>setForm(f=>({...f,title:v}))} />
          <FTextarea label="Description" value={form.description} onChange={v=>setForm(f=>({...f,description:v}))} rows={4} />
          <FSelect label="Category" value={form.category} onChange={v=>setForm(f=>({...f,category:v}))} options={["Feature Request","Bug Report","UI Improvement","Performance","Other"]} />
          <FSelect label="Priority" value={form.priority} onChange={v=>setForm(f=>({...f,priority:v}))} options={["low","medium","high"]} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <Btn onClick={()=>setShowModal(false)} variant="outline">Cancel</Btn>
            <Btn onClick={save}>Submit</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Users ────────────────────────────────────────────────────────────────────
function Users() {
  return (
    <div style={{ padding:32 }}>
      <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:"0 0 8px" }}>Invite Users</h1>
      <p style={{ color:C.slate600, marginBottom:24 }}>Manage team access to ChartReview Pro</p>
      <Card>
        <div style={{ textAlign:"center", padding:"40px 20px", color:C.slate400 }}>
          <div style={{ fontSize:40, marginBottom:10 }}>👥</div>
          <div style={{ fontSize:15, fontWeight:600, color:C.slate600, marginBottom:4 }}>User management</div>
          <div style={{ fontSize:13 }}>Invite team members through the Base44 app settings → Users section.</div>
        </div>
      </Card>
    </div>
  );
}

// ─── Split PDF (placeholder — AWS would handle this) ──────────────────────────
function SplitPdf() {
  const [url, setUrl] = useState("");
  const [splitting, setSplitting] = useState(false);
  const fileRef = useRef();

  const handleFile = async e => {
    const file = e.target.files[0];
    if (!file) return;
    setSplitting(true);
    try {
      // Upload to AWS then call split endpoint
      alert("PDF splitting requires uploading to AWS first. Use the Upload page to upload large PDFs — they are auto-split.");
    } catch(e) { alert(e.message); }
    setSplitting(false);
  };

  return (
    <div style={{ padding:32 }}>
      <h1 style={{ fontSize:28, fontWeight:700, color:C.slate900, margin:"0 0 8px" }}>Split PDF</h1>
      <p style={{ color:C.slate600, marginBottom:24 }}>Split large PDFs into smaller parts for processing</p>
      <Card>
        <div style={{ textAlign:"center", padding:"40px 20px" }}>
          <div style={{ fontSize:40, marginBottom:10 }}>✂️</div>
          <div style={{ fontSize:15, fontWeight:600, color:C.slate900, marginBottom:4 }}>Auto-split on Upload</div>
          <div style={{ fontSize:13, color:C.slate500, marginBottom:20 }}>PDFs over 10MB are automatically split into parts when uploaded through the Upload Documents page. Each part is processed separately.</div>
          <Btn onClick={()=>fileRef.current.click()} disabled={splitting}>{splitting?"Processing…":"Upload PDF to Split"}</Btn>
          <input ref={fileRef} type="file" accept=".pdf" style={{ display:"none" }} onChange={handleFile} />
        </div>
      </Card>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
function AppInner() {
  const [page,      setPage]      = useState("dashboard");
  const [patients,  setPatients]  = useState([]);
  const [documents, setDocuments] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [loading,   setLoading]   = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const pData = await awsGet("/patients").catch(()=>({ patients:[] }));
      const pts = pData.patients || [];
      setPatients(pts);

      if (pts.length > 0) {
        const docResults = await Promise.all(pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(()=>[])));
        // Each result might be an array or {documents:[...]}
        const allDocs = docResults.flatMap(r => Array.isArray(r) ? r : (r.documents||[]));
        setDocuments(allDocs);

        const sumResults = await Promise.all(
          pts.map(p => awsGet(`/summaries?patient_id=${p.aws_patient_id}`).catch(()=>({ summaries:[] })))
        );
        setSummaries(sumResults.flatMap(r=>r.summaries||[]));
      } else {
        setDocuments([]); setSummaries([]);
      }
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const nav = p => setPage(p);

  const renderPage = () => {
    if (loading) return <Spinner text="Loading ChartReview Pro…" />;
    switch(page) {
      case "dashboard":  return <Dashboard onNav={nav} patients={patients} documents={documents} summaries={summaries} />;
      case "upload":     return <Upload patients={patients} onRefresh={loadAll} />;
      case "library":    return <Library documents={documents} onRefresh={loadAll} />;
      case "duplicates": return <Duplicates documents={documents} onRefresh={loadAll} />;
      case "summaries":  return <MedicalSummaries summaries={summaries} patients={patients} documents={documents} onRefresh={loadAll} />;
      case "splitpdf":   return <SplitPdf />;
      case "settings":   return <Settings />;
      case "breaches":   return <BreachNotifications />;
      case "suggestions":return <Suggestions />;
      case "users":      return <Users />;
      default:           return null;
    }
  };

  return (
    <Layout page={page} onNav={nav}>
      {renderPage()}
    </Layout>
  );
}

export default function App() {
  return (
    <UploadProvider>
      <AppInner />
    </UploadProvider>
  );
}
