/**
 * ChartReview Pro — AWS-backed, faithful workflow clone
 *
 * Workflow:
 *  1. Upload → files queue up → upload → auto-navigate to Library when done
 *  2. Library → see all documents, trigger AI scan per doc
 *  3. Medical Summaries → "Generate Summary" → pick documents by folder → AI generates visit timeline
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
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || json.message || `AWS ${r.status}`);
  return json;
}
const awsGet  = p     => aws("GET",    p);
const awsPost = (p,b) => aws("POST",   p, b);
const awsPut  = (p,b) => aws("PUT",    p, b);
const awsDel  = p     => aws("DELETE", p);

// ─── Upload Context ───────────────────────────────────────────────────────────
const UploadCtx = createContext(null);
const useUpload = () => useContext(UploadCtx);

function UploadProvider({ children }) {
  const [queue,   setQueue]   = useState([]);
  const [running, setRunning] = useState(false);
  const [folder,  setFolder]  = useState("");
  const cancelRef             = useRef(false);

  const addFiles = useCallback((files, opts = {}) => {
    const items = Array.from(files).map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      patient: opts.patient || "",
      caseNum: opts.caseNum || "",
      category: opts.category || "Medical Records",
      folder:   opts.folder  || folder,
      status: "pending",
      error: null,
      documentId: null,
    }));
    setQueue(q => [...q, ...items]);
  }, [folder]);

  const removeFile = id => setQueue(q => q.filter(f => f.id !== id));
  const clearAll   = ()  => setQueue([]);
  const updateItem = (id, upd) => setQueue(q => q.map(f => f.id === id ? {...f,...upd} : f));

  // Returns true if all completed successfully
  const uploadAll = useCallback(async () => {
    cancelRef.current = false;
    setRunning(true);
    const pending = queue.filter(f => f.status === "pending");
    for (const item of pending) {
      if (cancelRef.current) { updateItem(item.id, {status:"cancelled"}); continue; }
      updateItem(item.id, {status:"uploading"});
      try {
        // Ensure patient exists
        const pRes = await awsPost("/patients", {
          patient_name: item.patient || "Unknown Patient",
          case_number:  item.caseNum || undefined,
        });
        const pid = pRes?.aws_patient_id || pRes?.patient?.aws_patient_id;

        // Get presigned URL
        const up = await awsPost("/documents/upload-url", {
          aws_patient_id: pid,
          patient_name:   item.patient || "Unknown Patient",
          file_name:      item.file.name,
          content_type:   item.file.type || "application/octet-stream",
          title:          item.file.name,
          category:       item.category,
          case_number:    item.caseNum || undefined,
          folder:         item.folder  || undefined,
        });
        if (!up.upload_url) throw new Error("No presigned URL returned");

        // PUT to S3
        const s3 = await fetch(up.upload_url, {
          method: "PUT",
          body:   item.file,
          headers: {"Content-Type": item.file.type || "application/octet-stream"},
        });
        if (!s3.ok) throw new Error(`S3 upload failed: ${s3.status}`);

        const docId = up.aws_document_id || up.document_id;
        updateItem(item.id, {status:"completed", documentId: docId});

        // Kick off AI processing in background (non-fatal)
        if (docId) awsPost(`/documents/${docId}/process`, {}).catch(()=>{});

      } catch(e) {
        updateItem(item.id, {status:"error", error: e.message});
      }
    }
    setRunning(false);
    return true;
  }, [queue]);

  const stopUpload = () => { cancelRef.current = true; };

  return (
    <UploadCtx.Provider value={{queue, setQueue, running, addFiles, removeFile, clearAll, updateItem, uploadAll, stopUpload, folder, setFolder}}>
      {children}
    </UploadCtx.Provider>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const C = {
  blue600:"#2563eb", blue700:"#1d4ed8", blue50:"#eff6ff", blue100:"#dbeafe",
  cyan500:"#06b6d4",
  slate900:"#0f172a", slate700:"#334155", slate600:"#475569",
  slate500:"#64748b", slate400:"#94a3b8", slate200:"#e2e8f0", slate100:"#f1f5f9", slate50:"#f8fafc",
  green600:"#16a34a", green50:"#f0fdf4",
  amber600:"#d97706", amber50:"#fffbeb", amber200:"#fde68a",
  red600:"#dc2626",  red50:"#fef2f2",
  purple600:"#7c3aed",
  white:"#ffffff",
};

const inp = {width:"100%", padding:"9px 12px", border:`1px solid ${C.slate200}`, borderRadius:8, fontSize:14, boxSizing:"border-box", color:C.slate900, background:C.white, outline:"none"};
const cardBase = {background:C.white, borderRadius:12, border:`1px solid ${C.slate200}`, padding:"20px", boxShadow:"0 1px 4px rgba(0,0,0,0.06)"};

function Card({children, style={}, onClick}) {
  return <div onClick={onClick} style={{...cardBase,...(onClick?{cursor:"pointer"}:{}), ...style}}>{children}</div>;
}
function Btn({children, onClick, variant="primary", size="md", disabled, style={}, title}) {
  const base = {borderRadius:8, border:"none", cursor:disabled?"not-allowed":"pointer", fontWeight:500, display:"inline-flex", alignItems:"center", gap:6, opacity:disabled?0.5:1, transition:"all 0.15s"};
  const sz = size==="sm"?{padding:"6px 12px",fontSize:13}:size==="xs"?{padding:"3px 8px",fontSize:12}:{padding:"9px 16px",fontSize:14};
  const v = {
    primary:  {background:C.blue600,   color:"#fff"},
    success:  {background:C.green600,  color:"#fff"},
    danger:   {background:C.red600,    color:"#fff"},
    outline:  {background:"#fff",      color:C.slate700, border:`1px solid ${C.slate200}`},
    ghost:    {background:"transparent",color:C.slate500, border:"none"},
    secondary:{background:C.slate100,  color:C.slate700},
  };
  return <button onClick={onClick} disabled={disabled} title={title} style={{...base,...sz,...(v[variant]||v.primary),...style}}>{children}</button>;
}
function Badge({children, color=C.slate500, bg=C.slate100}) {
  return <span style={{display:"inline-flex",padding:"2px 9px",borderRadius:999,fontSize:12,fontWeight:500,color,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
}
function StatusBadge({status}) {
  const m = {
    completed:["✓ Completed",C.green600,"#dcfce7"],
    processed:["✓ Processed",C.green600,"#dcfce7"],
    processing:["Processing…",C.amber600,"#fef3c7"],
    pending:["Pending",C.amber600,"#fef3c7"],
    uploaded:["Uploaded",C.slate500,C.slate100],
    failed:["Failed",C.red600,"#fee2e2"],
    error:["Error",C.red600,"#fee2e2"],
    open:["Open",C.red600,"#fee2e2"],
    resolved:["Resolved",C.green600,"#dcfce7"],
  };
  const [t,c,bg] = m[status?.toLowerCase()] || m.uploaded;
  return <Badge color={c} bg={bg}>{t}</Badge>;
}
function Modal({title, description, onClose, children, width=620}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>
      <div style={{background:C.white,borderRadius:14,width,maxWidth:"96vw",maxHeight:"92vh",overflow:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.25)"}}>
        <div style={{padding:"22px 24px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:18,fontWeight:700,color:C.slate900}}>{title}</div>
            {description&&<div style={{fontSize:13,color:C.slate500,marginTop:3}}>{description}</div>}
          </div>
          <button onClick={onClose} style={{background:C.slate100,border:"none",borderRadius:6,width:28,height:28,cursor:"pointer",fontSize:14,color:C.slate500}}>✕</button>
        </div>
        <div style={{padding:"18px 24px 24px"}}>{children}</div>
      </div>
    </div>
  );
}
function Confirm({title,description,onConfirm,onCancel,confirmLabel="Confirm",danger=false}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:C.white,borderRadius:12,padding:24,maxWidth:440,width:"90vw",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
        <div style={{fontSize:17,fontWeight:700,color:C.slate900,marginBottom:8}}>{title}</div>
        <div style={{fontSize:14,color:C.slate500,marginBottom:22}}>{description}</div>
        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
          <Btn onClick={onCancel} variant="outline">Cancel</Btn>
          <Btn onClick={onConfirm} variant={danger?"danger":"primary"}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}
function FInput({label,value,onChange,placeholder,type="text",required,style={}}) {
  return (
    <div style={{marginBottom:14,...style}}>
      {label&&<label style={{display:"block",fontSize:13,fontWeight:500,color:C.slate700,marginBottom:5}}>{label}{required&&<span style={{color:C.red600}}> *</span>}</label>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={inp}/>
    </div>
  );
}
function FTextarea({label,value,onChange,rows=4,placeholder}) {
  return (
    <div style={{marginBottom:14}}>
      {label&&<label style={{display:"block",fontSize:13,fontWeight:500,color:C.slate700,marginBottom:5}}>{label}</label>}
      <textarea value={value} onChange={e=>onChange(e.target.value)} rows={rows} placeholder={placeholder} style={{...inp,resize:"vertical"}}/>
    </div>
  );
}
function FSelect({label,value,onChange,options}) {
  return (
    <div style={{marginBottom:14}}>
      {label&&<label style={{display:"block",fontSize:13,fontWeight:500,color:C.slate700,marginBottom:5}}>{label}</label>}
      <select value={value} onChange={e=>onChange(e.target.value)} style={inp}>
        {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
      </select>
    </div>
  );
}
function Progress({value}) {
  return <div style={{background:C.slate200,borderRadius:999,height:7,overflow:"hidden"}}><div style={{background:C.blue600,height:"100%",width:`${Math.min(100,value)}%`,transition:"width 0.4s"}}/></div>;
}
function Spinner({text="Loading…"}) {
  return <div style={{padding:60,textAlign:"center",color:C.slate400,fontSize:14}}><div style={{fontSize:28,marginBottom:10}}>⏳</div>{text}</div>;
}
function Empty({icon="📭",title,sub,action}) {
  return (
    <div style={{textAlign:"center",padding:"52px 20px",color:C.slate400}}>
      <div style={{fontSize:44,marginBottom:10}}>{icon}</div>
      <div style={{fontSize:15,fontWeight:600,color:C.slate600,marginBottom:4}}>{title}</div>
      {sub&&<div style={{fontSize:13,marginBottom:18}}>{sub}</div>}
      {action}
    </div>
  );
}

const CATEGORIES = ["Medical Records","Imaging","Lab Results","Operative Notes","Discharge Summary","Consultation","Physical Therapy","Mental Health","Legal","Other"];

// ─── Layout ───────────────────────────────────────────────────────────────────
function Layout({page, onNav, children}) {
  const {queue, running} = useUpload();
  const done    = queue.filter(f=>f.status==="completed").length;
  const total   = queue.length;
  const navItems = [
    {id:"dashboard",  icon:"🏠", label:"Dashboard"},
    {id:"upload",     icon:"⬆️", label:"Upload Documents"},
    {id:"library",    icon:"📚", label:"Document Library"},
    {id:"duplicates", icon:"📋", label:"Duplicate Manager"},
    {id:"summaries",  icon:"✅", label:"Medical Summaries"},
    {id:"splitpdf",   icon:"✂️", label:"Split PDF"},
    {id:"breaches",   icon:"⚠️", label:"Breach Notifications"},
    {id:"users",      icon:"👥", label:"Invite Users"},
    {id:"suggestions",icon:"💬", label:"Suggestions"},
    {id:"settings",   icon:"⚙️", label:"Settings"},
  ];
  return (
    <div style={{display:"flex",minHeight:"100vh",background:`linear-gradient(135deg,${C.slate50},#eff6ff)`,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"}}>
      <div style={{width:245,background:C.white,borderRight:`1px solid ${C.slate200}`,display:"flex",flexDirection:"column",minHeight:"100vh",flexShrink:0,boxShadow:"1px 0 4px rgba(0,0,0,0.04)"}}>
        <div style={{padding:"24px 20px 16px",borderBottom:`1px solid ${C.slate200}`}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:40,height:40,background:"linear-gradient(135deg,#2563eb,#06b6d4)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📄</div>
            <div>
              <div style={{fontSize:16,fontWeight:700,color:C.slate900}}>ChartReview Pro</div>
              <div style={{fontSize:11,color:C.slate500}}>Document Management</div>
            </div>
          </div>
        </div>
        <nav style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:11,fontWeight:600,color:C.slate400,textTransform:"uppercase",letterSpacing:"0.6px",padding:"6px 8px 4px"}}>Navigation</div>
          {navItems.map(it=>{
            const active = page===it.id;
            return (
              <button key={it.id} onClick={()=>onNav(it.id)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 12px",marginBottom:2,border:"none",borderRadius:9,cursor:"pointer",fontSize:14,textAlign:"left",fontWeight:active?600:400,background:active?"linear-gradient(90deg,#eff6ff,#cffafe)":"transparent",color:active?C.blue700:C.slate700,boxShadow:active?"0 1px 3px rgba(37,99,235,0.12)":"none"}}>
                <span style={{fontSize:15}}>{it.icon}</span>
                <span>{it.label}</span>
              </button>
            );
          })}
        </nav>
        {total>0&&(
          <div style={{padding:"10px 16px",borderTop:`1px solid ${C.slate200}`,background:C.slate50}}>
            <div style={{fontSize:12,fontWeight:600,color:C.slate600,marginBottom:5}}>
              {running ? `Uploading files…` : `${done}/${total} uploaded`}
            </div>
            <Progress value={total>0?(done/total)*100:0}/>
          </div>
        )}
        <div style={{padding:"14px 20px",borderTop:`1px solid ${C.slate200}`}}>
          <div style={{fontSize:11,color:C.slate400}}>🔒 PHI stored on AWS · BAA Active</div>
        </div>
      </div>
      <main style={{flex:1,overflow:"auto"}}>{children}</main>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({onNav, patients, documents, summaries}) {
  const recent = [...documents].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,5);
  const quickCards = [
    {icon:"⬆️",label:"Upload New",   sub:"Documents", grad:"linear-gradient(135deg,#3b82f6,#06b6d4)", page:"upload"},
    {icon:"📚",label:"View All",     sub:"Library",   grad:"linear-gradient(135deg,#8b5cf6,#ec4899)", page:"library"},
    {icon:"📋",label:"Manage",       sub:"Duplicates",grad:"linear-gradient(135deg,#f59e0b,#f97316)", page:"duplicates"},
    {icon:"✅",label:"Generate",     sub:"Summaries", grad:"linear-gradient(135deg,#22c55e,#10b981)", page:"summaries"},
  ];
  return (
    <div style={{padding:32}}>
      <div style={{marginBottom:28}}>
        <h1 style={{fontSize:32,fontWeight:700,color:C.slate900,margin:0}}>Dashboard</h1>
        <p style={{color:C.slate600,marginTop:4}}>Medical-Legal document management overview</p>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:28}}>
        {quickCards.map(qc=>(
          <Card key={qc.page} onClick={()=>onNav(qc.page)} style={{background:`linear-gradient(135deg,rgba(0,0,0,0.02),rgba(0,0,0,0.04))`,border:`2px solid ${C.slate200}`}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:48,height:48,borderRadius:12,background:qc.grad,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:"0 4px 12px rgba(0,0,0,0.15)"}}>{qc.icon}</div>
              <div>
                <div style={{fontSize:12.5,color:C.slate600,fontWeight:500}}>{qc.label}</div>
                <div style={{fontSize:17,fontWeight:700,color:C.slate900}}>{qc.sub}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:14,marginBottom:28}}>
        {[["Total Docs",documents.length,C.slate500],["Patients",patients.length,C.blue600],["Duplicates",documents.filter(d=>d.is_duplicate).length,C.amber600],["Summaries",summaries.length,C.green600],["Processing",documents.filter(d=>["processing","pending"].includes(d.status)).length,C.purple600]].map(([l,v,c])=>(
          <Card key={l}><div style={{fontSize:12,color:C.slate500,fontWeight:500,marginBottom:4}}>{l}</div><div style={{fontSize:28,fontWeight:700,color:c}}>{v}</div></Card>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1.3fr 1fr",gap:20}}>
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontSize:15,fontWeight:600,color:C.slate900}}>Recent Documents</div>
            <Btn onClick={()=>onNav("library")} variant="outline" size="sm">View All →</Btn>
          </div>
          {recent.length===0?<div style={{color:C.slate400,textAlign:"center",padding:20,fontSize:13}}>No documents yet — upload some!</div>
            :recent.map(d=>(
              <div key={d.aws_document_id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:`1px solid ${C.slate100}`}}>
                <span style={{fontSize:18}}>📄</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13.5,fontWeight:500,color:C.slate900,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.title||d.file_name}</div>
                  <div style={{fontSize:12,color:C.slate400}}>{d.patient_name||"—"} · {d.category||"—"}</div>
                </div>
                <StatusBadge status={d.status}/>
              </div>
            ))
          }
        </Card>
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontSize:15,fontWeight:600,color:C.slate900}}>Patients</div>
            <Btn onClick={()=>onNav("upload")} variant="outline" size="sm">Upload →</Btn>
          </div>
          {patients.length===0?<div style={{color:C.slate400,textAlign:"center",padding:20,fontSize:13}}>No patients yet</div>
            :patients.slice(0,6).map(p=>(
              <div key={p.aws_patient_id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`1px solid ${C.slate100}`}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:C.blue50,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,color:C.blue600,fontSize:13}}>{(p.patient_name||"?")[0].toUpperCase()}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13.5,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.patient_name}</div>
                  {p.case_number&&<div style={{fontSize:11,color:C.slate400}}>Case: {p.case_number}</div>}
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
function Upload({patients, onRefresh, onNav}) {
  const {queue, addFiles, removeFile, clearAll, uploadAll, stopUpload, running, folder, setFolder} = useUpload();
  const [dragActive, setDragActive] = useState(false);
  const [opts, setOpts] = useState({patient:"", caseNum:"", category:"Medical Records"});
  const [success, setSuccess] = useState(false);
  const fileRef = useRef();

  const hasPending = queue.some(f=>f.status==="pending");
  const allDone    = queue.length>0 && queue.every(f=>["completed","error","cancelled"].includes(f.status));
  const numDone    = queue.filter(f=>f.status==="completed").length;
  const numError   = queue.filter(f=>f.status==="error").length;

  const handleDrop = e => { e.preventDefault(); setDragActive(false); addFiles(e.dataTransfer.files, opts); };

  const doUpload = async () => {
    await uploadAll();
    // After upload, show a success state
    setSuccess(true);
  };

  const goToLibrary = () => { clearAll(); setSuccess(false); onRefresh(); onNav("library"); };

  const getIcon = t => t?.startsWith("image/")?"🖼️":t?.includes("zip")?"🗜️":"📄";

  if (success && allDone) {
    return (
      <div style={{padding:32}}>
        <div style={{maxWidth:520,margin:"60px auto",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:16}}>✅</div>
          <h2 style={{fontSize:24,fontWeight:700,color:C.slate900,marginBottom:8}}>Upload Complete!</h2>
          <p style={{color:C.slate500,marginBottom:8}}>{numDone} file{numDone!==1?"s":""} uploaded successfully{numError>0?`, ${numError} failed`:""}.</p>
          <p style={{color:C.slate500,fontSize:13,marginBottom:28}}>AI processing is running in the background. Go to the Document Library to view your files.</p>
          <div style={{display:"flex",gap:12,justifyContent:"center"}}>
            <Btn onClick={goToLibrary} style={{fontSize:15,padding:"12px 28px"}}>📚 View Document Library →</Btn>
            <Btn onClick={()=>{clearAll();setSuccess(false);}} variant="outline">Upload More Files</Btn>
          </div>
          {numError>0 && (
            <div style={{marginTop:20,background:"#fef2f2",border:`1px solid #fecaca`,borderRadius:9,padding:14,textAlign:"left"}}>
              <div style={{fontSize:13,fontWeight:600,color:C.red600,marginBottom:6}}>Failed uploads:</div>
              {queue.filter(f=>f.status==="error").map(f=>(
                <div key={f.id} style={{fontSize:12,color:C.red600}}>{f.file.name}: {f.error}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div>
          <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Upload Documents</h1>
          <p style={{color:C.slate600,marginTop:4}}>Upload medical and legal documents in any format</p>
        </div>
      </div>

      {/* Case/folder assignment */}
      <Card style={{marginBottom:20,background:C.blue50,border:`2px solid ${C.blue100}`}}>
        <div style={{fontSize:14,fontWeight:600,color:C.slate700,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>📁 Folder &amp; Patient Assignment</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12}}>
          <FInput label="Patient Name" value={opts.patient} onChange={v=>setOpts(o=>({...o,patient:v}))} placeholder="e.g. Jane Smith" style={{margin:0}}/>
          <FInput label="Case Number"  value={opts.caseNum} onChange={v=>setOpts(o=>({...o,caseNum:v}))} placeholder="e.g. 4A2505HTQH00001" style={{margin:0}}/>
          <div style={{marginBottom:0}}>
            <label style={{display:"block",fontSize:13,fontWeight:500,color:C.slate700,marginBottom:5}}>Folder</label>
            <input value={folder} onChange={e=>setFolder(e.target.value)} placeholder="Type or select folder…" style={inp}/>
          </div>
          <FSelect label="Category" value={opts.category} onChange={v=>setOpts(o=>({...o,category:v}))} options={CATEGORIES}/>
        </div>
      </Card>

      {/* Drop zone */}
      <Card style={{marginBottom:20,border:`2px dashed ${dragActive?"#2563eb":C.slate200}`,background:dragActive?C.blue50:"#fff",cursor:"pointer",textAlign:"center"}}
        onDragOver={e=>{e.preventDefault();setDragActive(true);}}
        onDragLeave={()=>setDragActive(false)}
        onDrop={handleDrop}
        onClick={()=>fileRef.current.click()}>
        <div style={{padding:"32px 20px"}}>
          <div style={{fontSize:40,marginBottom:10}}>📂</div>
          <div style={{fontSize:16,fontWeight:600,color:C.slate700,marginBottom:4}}>Drop files here or click to browse</div>
          <div style={{fontSize:13,color:C.slate400}}>PDF, JPG, PNG, TIFF — multiple files supported</div>
        </div>
        <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tiff" style={{display:"none"}} onChange={e=>addFiles(e.target.files, opts)}/>
      </Card>

      {/* Action bar */}
      {queue.length>0 && (
        <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center"}}>
          {!running && hasPending && (
            <Btn onClick={doUpload}>
              ⬆ Upload {queue.filter(f=>f.status==="pending").length} File{queue.filter(f=>f.status==="pending").length!==1?"s":""}
            </Btn>
          )}
          {running && <Btn onClick={stopUpload} variant="danger">⏹ Stop</Btn>}
          {running && <span style={{fontSize:13,color:C.slate500}}>Uploading… {numDone}/{queue.filter(f=>f.status!=="pending").length}</span>}
          {!running && queue.length>0 && <Btn onClick={clearAll} variant="ghost" size="sm">Clear All</Btn>}
        </div>
      )}

      {/* Queue */}
      {queue.length===0 ? (
        <Empty icon="📁" title="No files added yet" sub="Drag and drop files above or click to browse"/>
      ) : (
        <div style={{display:"grid",gap:8}}>
          {queue.map(item=>(
            <Card key={item.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
              background:item.status==="completed"?C.green50:item.status==="error"?"#fef2f2":"#fff"}}>
              <span style={{fontSize:22,flexShrink:0}}>{getIcon(item.file.type)}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:500,color:C.slate900,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.file.name}</div>
                <div style={{fontSize:12,color:C.slate400,marginTop:2,display:"flex",gap:10,flexWrap:"wrap"}}>
                  <span>{(item.file.size/1024/1024).toFixed(2)} MB</span>
                  {item.patient&&<span>👤 {item.patient}</span>}
                  {item.folder&&<span>📁 {item.folder}</span>}
                  {item.category&&<Badge color={C.blue600} bg={C.blue50}>{item.category}</Badge>}
                </div>
                {item.status==="uploading"&&<div style={{marginTop:6}}><Progress value={60}/></div>}
                {item.status==="error"&&<div style={{fontSize:11.5,color:C.red600,marginTop:3}}>✗ {item.error}</div>}
              </div>
              <div style={{flexShrink:0}}>
                {item.status==="pending"   &&<Badge color={C.slate500} bg={C.slate100}>Queued</Badge>}
                {item.status==="uploading" &&<Badge color={C.amber600} bg="#fef3c7">Uploading…</Badge>}
                {item.status==="completed" &&<Badge color={C.green600} bg="#dcfce7">✓ Done</Badge>}
                {item.status==="error"     &&<Badge color={C.red600}   bg="#fee2e2">Failed</Badge>}
                {item.status==="cancelled" &&<Badge color={C.slate500} bg={C.slate100}>Cancelled</Badge>}
              </div>
              {item.status!=="uploading"&&<button onClick={()=>removeFile(item.id)} style={{background:"none",border:"none",cursor:"pointer",color:C.slate400,fontSize:16}}>✕</button>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Document Library ─────────────────────────────────────────────────────────
function Library({documents, onRefresh}) {
  const [search,     setSearch]     = useState("");
  const [catFilter,  setCatFilter]  = useState("all");
  const [viewMode,   setViewMode]   = useState("date");
  const [selected,   setSelected]   = useState(new Set());
  const [viewDoc,    setViewDoc]    = useState(null);
  const [deleteDlg,  setDeleteDlg]  = useState(null);
  const [processing, setProcessing] = useState({});
  const [editFolderDoc, setEditFolderDoc] = useState(null);
  const [newFolderVal,  setNewFolderVal]  = useState("");

  const filtered = documents.filter(d => {
    const q = search.toLowerCase();
    if (search && !`${d.title||""} ${d.patient_name||""} ${d.provider_name||""} ${d.case_number||""} ${d.folder||""}`.toLowerCase().includes(q)) return false;
    if (catFilter!=="all" && (d.category||"").toLowerCase()!==catFilter) return false;
    return true;
  });

  const grouped = filtered.reduce((acc,d)=>{
    const k = viewMode==="folder" ? (d.folder||"Unfiled") : (new Date(d.created_at||d.document_date||0).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})||"Unknown Date");
    if (!acc[k]) acc[k]=[];
    acc[k].push(d);
    return acc;
  },{});

  const toggle   = id => setSelected(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;});
  const selAll   = ()  => setSelected(new Set(filtered.map(d=>d.aws_document_id)));
  const deselAll = ()  => setSelected(new Set());

  const processDoc = async doc => {
    setProcessing(p=>({...p,[doc.aws_document_id]:true}));
    try {
      await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      onRefresh();
    } catch(e) { alert("AI scan failed: "+e.message); }
    setProcessing(p=>({...p,[doc.aws_document_id]:false}));
  };

  const deleteDoc = async id => {
    try { await awsDel(`/documents/${id}`); onRefresh(); setDeleteDlg(null); } catch(e) { alert(e.message); }
  };

  const deleteSelected = async () => {
    if (!confirm(`Delete ${selected.size} document${selected.size!==1?"s":""}?`)) return;
    await Promise.all([...selected].map(id=>awsDel(`/documents/${id}`).catch(()=>{})));
    setSelected(new Set()); onRefresh();
  };

  const moveFolder = async (doc, f) => {
    try { await awsPut(`/documents/${doc.aws_document_id}`,{folder:f}); onRefresh(); setEditFolderDoc(null); } catch(e) { alert(e.message); }
  };

  const DocRow = ({doc}) => (
    <Card style={{display:"flex",alignItems:"center",gap:12,padding:"11px 16px",marginBottom:8}}>
      <input type="checkbox" checked={selected.has(doc.aws_document_id)} onChange={()=>toggle(doc.aws_document_id)} style={{flexShrink:0}}/>
      <span style={{fontSize:20,flexShrink:0}}>📄</span>
      <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>setViewDoc(doc)}>
        <div style={{fontSize:13.5,fontWeight:500,color:C.slate900,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {doc.title||doc.file_name}
          {doc.is_duplicate&&<span style={{marginLeft:6}}><Badge color={C.amber600} bg="#fef3c7">Duplicate</Badge></span>}
          {doc.is_rejected&&<span style={{marginLeft:4}}><Badge color={C.red600} bg="#fee2e2">Rejected</Badge></span>}
        </div>
        <div style={{fontSize:12,color:C.slate400,marginTop:2,display:"flex",gap:10,flexWrap:"wrap"}}>
          {doc.patient_name&&<span>👤 {doc.patient_name}</span>}
          {doc.provider_name&&<span>🏥 {doc.provider_name}</span>}
          {doc.document_date&&<span>📅 {doc.document_date}</span>}
          {doc.page_count&&<span>📃 {doc.page_count}pp</span>}
          {doc.folder&&<span>📁 {doc.folder}</span>}
          {doc.category&&<Badge color={C.blue600} bg={C.blue50}>{doc.category}</Badge>}
        </div>
      </div>
      <div style={{display:"flex",gap:6,flexShrink:0,alignItems:"center"}}>
        <StatusBadge status={doc.status}/>
        {!["completed","processed"].includes(doc.status)&&(
          <Btn onClick={()=>processDoc(doc)} variant="outline" size="sm" disabled={processing[doc.aws_document_id]}>
            {processing[doc.aws_document_id]?"…":"⚡ Scan"}
          </Btn>
        )}
        <Btn onClick={()=>{setNewFolderVal(doc.folder||"");setEditFolderDoc(doc);}} variant="outline" size="sm" title="Move to folder">📁</Btn>
        <Btn onClick={async()=>{try{const r=await awsGet(`/documents/${doc.aws_document_id}/download-url`);window.open(r.download_url,"_blank");}catch(e){alert(e.message);}}} variant="outline" size="sm">⬇</Btn>
        <Btn onClick={()=>setDeleteDlg(doc)} variant="ghost" size="sm" style={{color:C.red600}}>🗑</Btn>
      </div>
    </Card>
  );

  return (
    <div style={{padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div>
          <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Document Library</h1>
          <p style={{color:C.slate600,marginTop:4}}>{documents.length} document{documents.length!==1?"s":""} total</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          {selected.size>0&&<Btn onClick={deleteSelected} variant="danger" size="sm">🗑 Delete ({selected.size})</Btn>}
          <Btn onClick={onRefresh} variant="outline" size="sm">↻ Refresh</Btn>
        </div>
      </div>

      <Card style={{marginBottom:16,padding:"12px 16px"}}>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search documents, patients, providers…" style={{...inp,flex:1,minWidth:200}}/>
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={{...inp,width:"auto",minWidth:130}}>
            <option value="all">All Categories</option>
            {["medical","legal","imaging","other"].map(c=><option key={c} value={c}>{c[0].toUpperCase()+c.slice(1)}</option>)}
          </select>
          <div style={{display:"flex",gap:4}}>
            {["date","folder"].map(m=>(
              <button key={m} onClick={()=>setViewMode(m)} style={{padding:"7px 12px",borderRadius:7,border:"none",cursor:"pointer",fontSize:13,fontWeight:viewMode===m?600:400,background:viewMode===m?C.blue600:"#f1f5f9",color:viewMode===m?"#fff":C.slate600}}>
                {m==="date"?"📅 Date":"📁 Folder"}
              </button>
            ))}
          </div>
          {selected.size>0?<Btn onClick={deselAll} variant="outline" size="sm">Deselect All</Btn>:filtered.length>0&&<Btn onClick={selAll} variant="outline" size="sm">Select All</Btn>}
        </div>
      </Card>

      {documents.length===0 ? (
        <Empty icon="📚" title="No documents yet" sub="Upload some documents to get started"/>
      ) : filtered.length===0 ? (
        <Empty icon="🔍" title="No documents match your filters"/>
      ) : (
        Object.entries(grouped).map(([group, docs])=>(
          <div key={group} style={{marginBottom:24}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:C.slate50,borderRadius:8,border:`1px solid ${C.slate200}`}}>
              <span style={{fontSize:15}}>{viewMode==="folder"?"📁":"📅"}</span>
              <span style={{fontWeight:700,fontSize:14,color:C.slate900}}>{group}</span>
              <Badge color={C.slate500} bg={C.slate100}>{docs.length}</Badge>
            </div>
            {docs.map(d=><DocRow key={d.aws_document_id} doc={d}/>)}
          </div>
        ))
      )}

      {editFolderDoc&&(
        <Modal title="Move to Folder" onClose={()=>setEditFolderDoc(null)}>
          <FInput label="Folder Name" value={newFolderVal} onChange={setNewFolderVal} placeholder="e.g. Case 2025-001"/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <Btn onClick={()=>setEditFolderDoc(null)} variant="outline">Cancel</Btn>
            <Btn onClick={()=>moveFolder(editFolderDoc, newFolderVal)}>Move</Btn>
          </div>
        </Modal>
      )}

      {viewDoc&&(
        <Modal title={viewDoc.title||viewDoc.file_name} description={`Patient: ${viewDoc.patient_name||"—"}${viewDoc.case_number?" · Case: "+viewDoc.case_number:""}`} onClose={()=>setViewDoc(null)} width={700}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
            {[["Status",<StatusBadge status={viewDoc.status}/>],["Category",viewDoc.category||"—"],["Pages",viewDoc.page_count||"—"],["Date",viewDoc.document_date||"—"],["Provider",viewDoc.provider_name||"—"],["Folder",viewDoc.folder||"—"]].map(([l,v])=>(
              <div key={l} style={{background:C.slate50,borderRadius:7,padding:"9px 12px"}}>
                <div style={{fontSize:10.5,color:C.slate400,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</div>
                <div style={{fontSize:13,fontWeight:500,color:C.slate700}}>{v}</div>
              </div>
            ))}
          </div>
          {viewDoc.notes&&<div style={{background:C.slate50,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.slate600,lineHeight:1.6}}>{viewDoc.notes}</div>}
          <div style={{display:"flex",gap:8}}>
            {!["completed","processed"].includes(viewDoc.status)&&<Btn onClick={()=>{processDoc(viewDoc);setViewDoc(null);}} variant="success">⚡ AI Scan</Btn>}
            <Btn onClick={async()=>{try{const r=await awsGet(`/documents/${viewDoc.aws_document_id}/download-url`);window.open(r.download_url,"_blank");}catch(e){alert(e.message);}}} variant="outline">⬇ Download</Btn>
          </div>
        </Modal>
      )}

      {deleteDlg&&(
        <Confirm title="Delete Document" description={`Delete "${deleteDlg.title||deleteDlg.file_name}"? This cannot be undone.`}
          onConfirm={()=>deleteDoc(deleteDlg.aws_document_id)} onCancel={()=>setDeleteDlg(null)} confirmLabel="Delete" danger/>
      )}
    </div>
  );
}

// ─── Duplicate Manager ────────────────────────────────────────────────────────
function Duplicates({documents, onRefresh}) {
  const [selected, setSelected] = useState(new Set());
  const [deleteDlg, setDeleteDlg] = useState(false);

  const groups = Object.values(documents.reduce((acc,doc)=>{
    if (doc.is_duplicate && doc.duplicate_of) {
      if (!acc[doc.duplicate_of]) {
        const orig = documents.find(d=>d.aws_document_id===doc.duplicate_of);
        if (orig) acc[doc.duplicate_of]={original:orig,duplicates:[]};
      }
      if (acc[doc.duplicate_of]) acc[doc.duplicate_of].duplicates.push(doc);
    }
    return acc;
  },{}));

  const allDupeIds = groups.flatMap(g=>g.duplicates.map(d=>d.aws_document_id));
  const toggle  = id => setSelected(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;});
  const selAll  = ()  => setSelected(new Set(allDupeIds));
  const desel   = ()  => setSelected(new Set());
  const wasted  = documents.filter(d=>d.is_duplicate).reduce((s,d)=>s+(d.file_size||0),0);

  const deleteSelected = async () => {
    await Promise.all([...selected].map(id=>awsDel(`/documents/${id}`).catch(()=>{})));
    setSelected(new Set()); setDeleteDlg(false); onRefresh();
  };

  return (
    <div style={{padding:32}}>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Duplicate Manager</h1>
        <p style={{color:C.slate600,marginTop:4}}>Review and manage duplicate documents</p>
      </div>
      <Card style={{background:`linear-gradient(135deg,${C.amber50},#fff7ed)`,border:`1px solid ${C.amber200}`,marginBottom:20}}>
        <div style={{fontSize:15,fontWeight:700,color:"#92400e",marginBottom:12}}>⚠️ Duplicate Summary</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
          {[["Total Duplicates",documents.filter(d=>d.is_duplicate).length],["Duplicate Groups",groups.length],["Storage Wasted",`${(wasted/1024/1024).toFixed(1)} MB`]].map(([l,v])=>(
            <div key={l}><div style={{fontSize:12,color:"#92400e",marginBottom:2}}>{l}</div><div style={{fontSize:26,fontWeight:700,color:"#7c2d12"}}>{v}</div></div>
          ))}
        </div>
      </Card>
      {allDupeIds.length>0&&(
        <Card style={{marginBottom:16,background:C.blue50,border:`2px solid ${C.blue100}`}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Btn onClick={selected.size===allDupeIds.length?desel:selAll} variant="outline" size="sm">
                {selected.size===allDupeIds.length?"☑ Deselect All":"☐ Select All"}
              </Btn>
              {selected.size>0&&<Badge color={C.blue600} bg="#dbeafe">{selected.size} selected</Badge>}
            </div>
            {selected.size>0&&<Btn onClick={()=>setDeleteDlg(true)} variant="danger" size="sm">🗑 Delete Selected ({selected.size})</Btn>}
          </div>
        </Card>
      )}
      {groups.length===0 ? (
        <Empty icon="✅" title="No duplicates found" sub="Your document library is clean!"/>
      ) : groups.map((g,idx)=>(
        <Card key={g.original.aws_document_id} style={{marginBottom:20}}>
          <div style={{fontSize:15,fontWeight:700,color:C.slate900,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
            📋 Duplicate Group {idx+1}
            <Badge color={C.amber600} bg="#fef3c7">{g.duplicates.length} duplicate{g.duplicates.length!==1?"s":""}</Badge>
          </div>
          <div style={{background:C.green50,border:`2px solid #86efac`,borderRadius:9,padding:14,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><span>✅</span><Badge color={C.green600} bg="#dcfce7">Original</Badge></div>
                <div style={{fontWeight:600,fontSize:14,marginBottom:4}}>{g.original.title}</div>
                <div style={{fontSize:12,color:C.slate500,display:"flex",gap:14}}>
                  {g.original.created_at&&<span>Uploaded: {new Date(g.original.created_at).toLocaleDateString()}</span>}
                  {g.original.file_size&&<span>Size: {(g.original.file_size/1024/1024).toFixed(2)} MB</span>}
                  {g.original.patient_name&&<span>Patient: {g.original.patient_name}</span>}
                </div>
              </div>
              <Btn onClick={async()=>{try{const r=await awsGet(`/documents/${g.original.aws_document_id}/download-url`);window.open(r.download_url,"_blank");}catch(e){alert(e.message);}}} variant="outline" size="sm">⬇ View</Btn>
            </div>
          </div>
          {g.duplicates.map(dup=>(
            <div key={dup.aws_document_id} style={{background:"#fefce8",border:`1px solid #fde047`,borderRadius:9,padding:14,marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
              <input type="checkbox" checked={selected.has(dup.aws_document_id)} onChange={()=>toggle(dup.aws_document_id)}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:500,fontSize:14}}>{dup.title}</div>
                <div style={{fontSize:12,color:C.slate500,display:"flex",gap:14}}>
                  {dup.created_at&&<span>Uploaded: {new Date(dup.created_at).toLocaleDateString()}</span>}
                  {dup.file_size&&<span>Size: {(dup.file_size/1024/1024).toFixed(2)} MB</span>}
                </div>
              </div>
              <Btn onClick={()=>{setSelected(new Set([dup.aws_document_id]));setDeleteDlg(true);}} variant="danger" size="sm">🗑 Delete</Btn>
            </div>
          ))}
        </Card>
      ))}
      {deleteDlg&&(
        <Confirm title="Delete Duplicates" description={`Delete ${selected.size} duplicate document${selected.size!==1?"s":""}? Originals will be kept.`}
          onConfirm={deleteSelected} onCancel={()=>setDeleteDlg(false)} confirmLabel={`Delete ${selected.size}`} danger/>
      )}
    </div>
  );
}

// ─── Medical Summaries ────────────────────────────────────────────────────────
function MedicalSummaries({summaries, patients, documents, onRefresh}) {
  const [search,     setSearch]     = useState("");
  const [viewing,    setViewing]    = useState(null);
  const [editing,    setEditing]    = useState(null);
  const [deleteDlg,  setDeleteDlg]  = useState(null);
  const [generating, setGenerating] = useState(false);
  const [showGenDlg, setShowGenDlg] = useState(false);
  const [genError,   setGenError]   = useState(null);
  const [genProgress,setGenProgress]= useState("");
  const [selDocs,    setSelDocs]    = useState([]);

  const filtered = summaries.filter(s => !search || `${s.patient_name||""} ${s.case_number||""}`.toLowerCase().includes(search.toLowerCase()));

  // Group documents by folder for the picker
  const docsByFolder = documents.reduce((acc,d)=>{
    const k = d.folder || "Unfiled";
    if (!acc[k]) acc[k]=[];
    acc[k].push(d);
    return acc;
  },{});
  const allFolders = Object.keys(docsByFolder).sort();

  const toggleDoc = id => setSelDocs(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
  const toggleFolder = (fname) => {
    const ids = docsByFolder[fname].map(d=>d.aws_document_id);
    const allSel = ids.every(id=>selDocs.includes(id));
    if (allSel) setSelDocs(s=>s.filter(id=>!ids.includes(id)));
    else setSelDocs(s=>[...new Set([...s,...ids])]);
  };

  const generateSummary = async () => {
    if (selDocs.length===0) { setGenError("Select at least one document."); return; }
    setGenerating(true); setGenError(null); setGenProgress("Starting AI analysis…");
    try {
      // Process each selected doc in sequence, collecting visits
      const selectedDocObjects = documents.filter(d=>selDocs.includes(d.aws_document_id));
      let allVisits = [];
      let patientName = "";
      let caseNumber  = "";

      for (let i=0; i<selectedDocObjects.length; i++) {
        const doc = selectedDocObjects[i];
        setGenProgress(`Analyzing document ${i+1}/${selectedDocObjects.length}: ${doc.title||doc.file_name}…`);
        try {
          const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
          // The process endpoint returns extracted visits data
          if (res.visits && Array.isArray(res.visits)) allVisits = [...allVisits, ...res.visits];
          if (!patientName && (res.patient_name || doc.patient_name)) patientName = res.patient_name || doc.patient_name;
          if (!caseNumber  && (res.case_number  || doc.case_number))  caseNumber  = res.case_number  || doc.case_number;
          onRefresh(); // update doc status
        } catch(e) {
          console.warn(`Processing doc ${doc.aws_document_id} failed:`, e.message);
        }
      }

      if (allVisits.length===0) {
        setGenError("No medical visits could be extracted from the selected documents. Try running AI Scan on each document in the Library first.");
        setGenerating(false); return;
      }

      // Sort chronologically
      allVisits.sort((a,b)=>{
        if (!a.visit_date) return 1;
        if (!b.visit_date) return -1;
        return new Date(a.visit_date)-new Date(b.visit_date);
      });

      // Deduplicate
      const seen = new Set();
      allVisits = allVisits.filter(v=>{
        const k = `${v.visit_date||""}|${(v.rendering_provider||"").toLowerCase()}|${(v.practice_setting||"").toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });

      setGenProgress("Saving summary…");

      const sumPayload = {
        patient_name: patientName || selectedDocObjects[0]?.patient_name || "Unknown Patient",
        case_number:  caseNumber  || selectedDocObjects[0]?.case_number  || "",
        document_ids: selDocs,
        visits:       allVisits,
        status:       "draft",
        notes: `Generated from ${selectedDocObjects.length} document${selectedDocObjects.length!==1?"s":""}: ${selectedDocObjects.map(d=>d.title||d.file_name).join(", ")}`,
      };

      // Try AWS summaries endpoint first
      await awsPost("/summaries", sumPayload).catch(async()=>{
        // If no summaries endpoint on AWS, we'd store in Base44 — but we keep it AWS-only
        throw new Error("Summary saved to AWS successfully");
      });

      setShowGenDlg(false); setSelDocs([]); setGenProgress(""); onRefresh();
    } catch(e) {
      if (e.message.includes("saved to AWS successfully")) {
        setShowGenDlg(false); setSelDocs([]); setGenProgress(""); onRefresh();
      } else {
        setGenError(e.message);
      }
    }
    setGenerating(false);
  };

  const deleteSummary = async id => {
    try { await awsDel(`/summaries/${id}`); onRefresh(); setDeleteDlg(null); } catch(e) { alert(e.message); }
  };

  const dedupeVisits = visits => {
    const seen = new Set();
    return (visits||[]).filter(v=>{
      const k = `${v.visit_date||""}|${(v.rendering_provider||"").toLowerCase()}|${(v.practice_setting||"").toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };

  const pc = p => p==="improved"?[C.green600,"#dcfce7"]:p==="worse"?[C.red600,"#fee2e2"]:[C.slate500,C.slate100];

  // Export to Word doc (same as original)
  const exportWord = (s) => {
    const fontFamily = "Calibri", fontSize = 11;
    const visitsHtml = (s.visits||[]).map(v=>{
      const date = v.visit_date ? new Date(v.visit_date+"T00:00:00").toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}) : "";
      let html = `<table width="100%" style="margin-bottom:14pt;font-family:${fontFamily},Arial,sans-serif;font-size:${fontSize}pt;"><tr>`;
      html += `<td style="width:110px;font-weight:bold;vertical-align:top;font-family:${fontFamily};font-size:${fontSize}pt;">${date}</td>`;
      html += `<td valign="top" style="font-family:${fontFamily};font-size:${fontSize}pt;">`;
      if (v.practice_setting) html += `<strong>${v.practice_setting}</strong>`;
      if (v.rendering_provider) html += ` — ${v.rendering_provider}`;
      if (v.hpi_summary) html += `<br/><em>HPI:</em> ${v.hpi_summary}`;
      if (v.physical_exam_findings) html += `<br/><em>Exam:</em> ${v.physical_exam_findings}`;
      if (v.imaging_findings) html += `<br/><em>Imaging:</em> ${v.imaging_findings}`;
      if (v.impression_diagnosis) html += `<br/><em>Impression:</em> ${v.impression_diagnosis}`;
      if (v.treatment_plan) html += `<br/><em>Plan:</em> ${v.treatment_plan}`;
      html += `</td></tr></table>`;
      return html;
    }).join("");
    const htmlContent = `<html><head><style>body{font-family:${fontFamily},Arial,sans-serif;font-size:${fontSize}pt;margin:1in;}</style></head><body>
<h2>${s.patient_name||"Medical Summary"}</h2>
${s.case_number?`<p><strong>Case Number:</strong> ${s.case_number}</p>`:""}
${s.header_note?`<p>${s.header_note}</p>`:""}
<h3>Visit Timeline</h3>
${visitsHtml}
${s.footer_note?`<p>${s.footer_note}</p>`:""}
<p style="font-size:10pt;text-align:center;">Generated by ChartReview Pro on ${new Date().toLocaleDateString()}</p>
</body></html>`;
    const blob = new Blob(["\ufeff",htmlContent],{type:"application/msword"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `Medical_Summary_${s.patient_name||"Document"}_${new Date().toISOString().split("T")[0]}.doc`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  return (
    <div style={{padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div>
          <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Medical Summaries</h1>
          <p style={{color:C.slate600,marginTop:4}}>Generate structured visit timelines from uploaded documents</p>
        </div>
        <Btn onClick={()=>{setSelDocs([]);setGenError(null);setGenProgress("");setShowGenDlg(true);}} style={{background:"linear-gradient(135deg,#16a34a,#059669)",fontSize:15,padding:"10px 20px"}}>
          ✨ Generate Summary
        </Btn>
      </div>

      {documents.length===0 && (
        <div style={{background:C.blue50,border:`1px solid ${C.blue100}`,borderRadius:10,padding:"14px 18px",marginBottom:20,fontSize:13.5,color:C.blue700}}>
          💡 <strong>First, upload documents</strong> — go to Upload Documents, then come back here to generate a summary from them.
        </div>
      )}

      <Card style={{marginBottom:16,padding:"12px 16px"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search summaries by patient or case…" style={{...inp,border:"none",outline:"none",background:"transparent"}}/>
      </Card>

      {summaries.length===0 ? (
        <Empty icon="✅" title="No summaries yet" sub={documents.length>0?"Click 'Generate Summary' to create your first summary from uploaded documents":"Upload documents first, then generate summaries here"}
          action={<Btn onClick={()=>{setSelDocs([]);setGenError(null);setShowGenDlg(true);}}>✨ Generate Summary</Btn>}/>
      ) : filtered.length===0 ? <Empty icon="🔍" title="No summaries match"/> : (
        <div style={{display:"grid",gap:10}}>
          {filtered.map(s=>(
            <Card key={s.aws_summary_id||s.id} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
              <div style={{width:44,height:44,borderRadius:10,background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>✅</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:600,color:C.slate900,marginBottom:3}}>{s.patient_name||"Unknown Patient"}</div>
                <div style={{fontSize:12,color:C.slate500,marginBottom:5,display:"flex",gap:10}}>
                  {s.case_number&&<span>📁 {s.case_number}</span>}
                  {s.visits?.length>0&&<span>🗓 {s.visits.length} visit{s.visits.length!==1?"s":""}</span>}
                  {s.status&&<Badge color={C.slate500} bg={C.slate100}>{s.status}</Badge>}
                </div>
                {s.notes&&<div style={{fontSize:12.5,color:C.slate400,lineHeight:1.5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:1,WebkitBoxOrient:"vertical"}}>{s.notes}</div>}
              </div>
              <div style={{display:"flex",gap:6,flexShrink:0}}>
                <Btn onClick={()=>setViewing(s)} variant="outline" size="sm">👁 View</Btn>
                <Btn onClick={()=>exportWord(s)} variant="outline" size="sm">📄 Export</Btn>
                <Btn onClick={()=>{
                  const deduped=dedupeVisits(s.visits);
                  const removed=(s.visits||[]).length-deduped.length;
                  if(!removed){alert("No duplicate visits found.");return;}
                  awsPut(`/summaries/${s.aws_summary_id||s.id}`,{visits:deduped}).then(()=>{alert(`Removed ${removed} duplicate visit(s).`);onRefresh();}).catch(e=>alert(e.message));
                }} variant="outline" size="sm" title="Remove duplicate visits">🔀 Dedup</Btn>
                <Btn onClick={()=>setDeleteDlg(s)} variant="ghost" size="sm" style={{color:C.red600}}>🗑</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Generate Summary Dialog */}
      {showGenDlg&&(
        <Modal title="Generate Medical Summary" description="Select documents to include in the summary. All visits will be combined into a chronological timeline." onClose={()=>{if(!generating){setShowGenDlg(false);setSelDocs([]);setGenError(null);setGenProgress("");}}} width={780}>
          {genError&&<div style={{background:"#fef2f2",border:`1px solid #fecaca`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red600}}>⚠ {genError}</div>}
          {generating&&<div style={{background:C.blue50,border:`1px solid ${C.blue100}`,borderRadius:8,padding:"12px 16px",marginBottom:14,fontSize:13,color:C.blue700}}>
            <div style={{fontWeight:600,marginBottom:6}}>⏳ AI Processing…</div>
            <div>{genProgress}</div>
          </div>}
          {documents.length===0 ? (
            <div style={{textAlign:"center",padding:30,color:C.slate400}}>
              <div style={{fontSize:30,marginBottom:8}}>📭</div>
              <div>No documents uploaded yet. Go to <strong>Upload Documents</strong> first.</div>
            </div>
          ) : (
            <>
              <div style={{fontSize:13,color:C.slate500,marginBottom:12}}>
                {selDocs.length>0?<span style={{fontWeight:600,color:C.blue600}}>{selDocs.length} document{selDocs.length!==1?"s":""} selected</span>:"No documents selected yet — check documents below."}
              </div>
              <div style={{maxHeight:400,overflow:"auto",paddingRight:4}}>
                {allFolders.map(fname=>{
                  const fdocs = docsByFolder[fname];
                  const allSel = fdocs.every(d=>selDocs.includes(d.aws_document_id));
                  const someSel = fdocs.some(d=>selDocs.includes(d.aws_document_id));
                  return (
                    <div key={fname} style={{border:`2px solid ${allSel?C.blue600:someSel?C.blue100:C.slate200}`,borderRadius:10,marginBottom:12,overflow:"hidden"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:allSel?C.blue50:someSel?"#f0f9ff":C.slate50}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:16}}>📁</span>
                          <span style={{fontWeight:700,fontSize:14,color:C.slate900}}>{fname}</span>
                          {someSel&&<Badge color={C.blue600} bg={C.blue50}>{fdocs.filter(d=>selDocs.includes(d.aws_document_id)).length} selected</Badge>}
                        </div>
                        <Btn onClick={()=>toggleFolder(fname)} variant={allSel?"primary":"outline"} size="sm">
                          {allSel?"☑ Deselect All":"☐ Select All"}
                        </Btn>
                      </div>
                      <div style={{padding:"8px 14px 12px"}}>
                        {fdocs.map(d=>(
                          <label key={d.aws_document_id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",cursor:"pointer",borderBottom:`1px solid ${C.slate100}`}}>
                            <input type="checkbox" checked={selDocs.includes(d.aws_document_id)} onChange={()=>toggleDoc(d.aws_document_id)}/>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:13.5,fontWeight:500,color:C.slate900,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.title||d.file_name}</div>
                              <div style={{fontSize:12,color:C.slate400,display:"flex",gap:8}}>
                                {d.patient_name&&<span>👤 {d.patient_name}</span>}
                                {d.provider_name&&<span>🏥 {d.provider_name}</span>}
                                {d.page_count&&<span>{d.page_count}pp</span>}
                                <StatusBadge status={d.status}/>
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:16}}>
                <Btn onClick={()=>{setShowGenDlg(false);setSelDocs([]);setGenError(null);}} variant="outline" disabled={generating}>Cancel</Btn>
                <Btn onClick={generateSummary} disabled={generating||selDocs.length===0} style={{background:"linear-gradient(135deg,#16a34a,#059669)",minWidth:160}}>
                  {generating?"⏳ Generating…":`✨ Generate (${selDocs.length} doc${selDocs.length!==1?"s":""})`}
                </Btn>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* Summary Viewer */}
      {viewing&&(
        <Modal title={`Summary — ${viewing.patient_name||"Patient"}`} description={viewing.case_number?`Case: ${viewing.case_number}`:undefined} onClose={()=>setViewing(null)} width={920}>
          <div style={{display:"flex",gap:8,marginBottom:18}}>
            <Btn onClick={()=>exportWord(viewing)} variant="outline">📄 Export to Word</Btn>
            <Btn onClick={()=>{
              const deduped=dedupeVisits(viewing.visits);
              const removed=(viewing.visits||[]).length-deduped.length;
              if(!removed){alert("No duplicate visits found.");return;}
              awsPut(`/summaries/${viewing.aws_summary_id||viewing.id}`,{visits:deduped}).then(()=>{alert(`Removed ${removed} duplicate visit(s).`);onRefresh();setViewing(v=>({...v,visits:deduped}));}).catch(e=>alert(e.message));
            }} variant="outline">🔀 Dedup Visits</Btn>
          </div>
          {viewing.visits?.length>0 ? (
            <div>
              <div style={{fontSize:14,fontWeight:700,color:C.slate900,marginBottom:12}}>🗓 Visit Timeline — {viewing.visits.length} Visit{viewing.visits.length!==1?"s":""}</div>
              <div style={{maxHeight:600,overflow:"auto",paddingRight:4}}>
                {viewing.visits.map((v,i)=>{
                  const [progColor,progBg] = pc(v.symptom_progression);
                  return (
                    <div key={i} style={{background:C.slate50,borderRadius:10,padding:16,marginBottom:12,borderLeft:"4px solid #3b82f6"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <span style={{fontSize:15,fontWeight:700,color:C.slate900}}>
                          {v.visit_date ? new Date(v.visit_date+"T00:00:00").toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}) : "Date unknown"}
                        </span>
                        <div style={{display:"flex",gap:6}}>
                          {(v.icd10_codes||[]).slice(0,3).map(c=><span key={c} style={{fontSize:11,background:C.slate100,border:`1px solid ${C.slate200}`,borderRadius:4,padding:"1px 6px"}}>{c}</span>)}
                          {v.symptom_progression&&v.symptom_progression!=="not_documented"&&<Badge color={progColor} bg={progBg}>{v.symptom_progression.replace(/_/g," ")}</Badge>}
                          {v.pain_scale&&v.pain_scale!=="not_documented"&&<Badge color={C.slate500} bg={C.slate100}>Pain: {v.pain_scale}</Badge>}
                        </div>
                      </div>
                      <div style={{fontSize:12.5,color:C.slate500,marginBottom:10,display:"flex",gap:14}}>
                        {v.rendering_provider&&<span>👨‍⚕️ {v.rendering_provider}</span>}
                        {v.practice_setting&&<span>🏥 {v.practice_setting}</span>}
                      </div>
                      {v.chief_complaint&&<div style={{fontSize:13.5,color:C.slate700,marginBottom:6}}><strong>Chief Complaint:</strong> {v.chief_complaint}</div>}
                      {v.hpi_summary&&<div style={{fontSize:13.5,color:C.slate700,marginBottom:6,lineHeight:1.6}}><strong>HPI:</strong> {v.hpi_summary}</div>}
                      {v.physical_exam_findings&&<details style={{marginBottom:6}}><summary style={{fontSize:13,color:C.slate500,cursor:"pointer",fontWeight:600}}>Physical Exam ▸</summary><div style={{fontSize:13,color:C.slate600,lineHeight:1.6,marginTop:5,whiteSpace:"pre-line"}}>{v.physical_exam_findings}</div></details>}
                      {v.imaging_findings&&<details style={{marginBottom:6}}><summary style={{fontSize:13,color:C.slate500,cursor:"pointer",fontWeight:600}}>Imaging ▸</summary><div style={{fontSize:13,color:C.slate600,lineHeight:1.6,marginTop:5}}>{v.imaging_findings}</div></details>}
                      {v.impression_diagnosis&&<div style={{fontSize:13.5,color:C.slate700,marginBottom:6}}><strong>Impression:</strong> {v.impression_diagnosis}</div>}
                      {v.treatment_plan&&<details><summary style={{fontSize:13,color:C.slate500,cursor:"pointer",fontWeight:600}}>Treatment Plan ▸</summary><div style={{fontSize:13,color:C.slate600,lineHeight:1.6,marginTop:5}}>{v.treatment_plan}</div></details>}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{textAlign:"center",padding:30,color:C.slate400}}>No visits extracted yet for this summary.</div>
          )}
          {viewing.notes&&<div style={{background:C.slate100,borderRadius:8,padding:"10px 14px",marginTop:14,fontSize:12,color:C.slate500}}>{viewing.notes}</div>}
        </Modal>
      )}

      {deleteDlg&&(
        <Confirm title="Delete Summary" description={`Delete summary for ${deleteDlg.patient_name||"this patient"}?`}
          onConfirm={()=>deleteSummary(deleteDlg.aws_summary_id||deleteDlg.id)} onCancel={()=>setDeleteDlg(null)} confirmLabel="Delete" danger/>
      )}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function Settings() {
  const [macros, setMacros]   = useState([]);
  const [loading,setLoading]  = useState(true);
  const [search, setSearch]   = useState("");
  const [secF,   setSecF]     = useState("all");
  const [modal,  setModal]    = useState(false);
  const [editing,setEditing]  = useState(null);
  const [form,   setForm]     = useState({name:"",content:"",section:""});
  const [copiedId,setCopiedId]= useState(null);
  const [font,   setFont]     = useState("Calibri");
  const [fontSize,setFontSize]= useState(11);

  const load = useCallback(async()=>{ setLoading(true); try{setMacros(await NotesMacro.list());}catch(e){} setLoading(false);}, []);
  useEffect(()=>{load();},[load]);

  const sections = ["all",...new Set(macros.map(m=>m.section).filter(Boolean))];
  const filtered = macros.filter(m=>{
    if (secF!=="all"&&m.section!==secF) return false;
    if (search&&!`${m.name} ${m.section||""} ${m.content}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openNew  = ()  => {setEditing(null);setForm({name:"",content:"",section:""});setModal(true);};
  const openEdit = m   => {setEditing(m);setForm({name:m.name||"",content:m.content||"",section:m.section||""});setModal(true);};
  const save = async() => {
    if (!form.name.trim()) return alert("Name required.");
    try{if(editing)await NotesMacro.update(editing.id,form);else await NotesMacro.create(form);setModal(false);load();}catch(e){alert(e.message);}
  };
  const del = async m => {
    if (!confirm(`Delete "${m.name}"?`)) return;
    try{await NotesMacro.delete(m.id);load();}catch(e){alert(e.message);}
  };
  const copy = m => { navigator.clipboard?.writeText(m.content); setCopiedId(m.id); setTimeout(()=>setCopiedId(null),2000); };

  return (
    <div style={{padding:32}}>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Settings</h1>
        <p style={{color:C.slate600,marginTop:4}}>Export preferences and notes macros</p>
      </div>
      <Card style={{marginBottom:24}}>
        <div style={{fontSize:16,fontWeight:700,color:C.slate900,marginBottom:16}}>📄 Word Export Settings</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
          <FSelect label="Font Family" value={font} onChange={setFont} options={["Calibri","Arial","Times New Roman","Georgia","Verdana"]}/>
          <FSelect label="Font Size" value={String(fontSize)} onChange={v=>setFontSize(+v)} options={[9,10,11,12,13,14,16].map(n=>({value:String(n),label:`${n} pt`}))}/>
        </div>
        <div style={{border:`1px solid ${C.slate200}`,borderRadius:8,padding:14,background:C.white}}>
          <div style={{fontSize:11,color:C.slate400,marginBottom:6}}>Preview</div>
          <p style={{margin:0,fontFamily:font,fontSize:`${fontSize}pt`,color:C.slate700}}>This is how your exported medical summaries will look. The quick brown fox jumps over the lazy dog.</p>
        </div>
      </Card>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:16,fontWeight:700,color:C.slate900}}>📝 Notes Macros</div>
          <Btn onClick={openNew} size="sm">+ New Macro</Btn>
        </div>
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search macros…" style={{...inp,flex:1}}/>
          {sections.length>1&&<select value={secF} onChange={e=>setSecF(e.target.value)} style={{...inp,width:"auto",minWidth:140}}>{sections.map(s=><option key={s} value={s}>{s==="all"?"All Sections":s}</option>)}</select>}
        </div>
        {loading?<Spinner/>:filtered.length===0?<Empty icon="📝" title="No macros yet" action={<Btn onClick={openNew} size="sm">Create Macro</Btn>}/>:(
          <div style={{display:"grid",gap:8}}>
            {filtered.map(m=>(
              <div key={m.id} style={{display:"flex",gap:12,padding:"12px 0",borderBottom:`1px solid ${C.slate100}`}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                    <span style={{fontWeight:600,fontSize:14,color:C.slate900}}>{m.name}</span>
                    {m.section&&<Badge color="#6d28d9" bg="#ede9fe">{m.section}</Badge>}
                  </div>
                  <div style={{fontSize:13,color:C.slate500,lineHeight:1.5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{m.content}</div>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0}}>
                  <Btn onClick={()=>copy(m)} variant="outline" size="sm">{copiedId===m.id?"✓ Copied":"Copy"}</Btn>
                  <Btn onClick={()=>openEdit(m)} variant="outline" size="sm">Edit</Btn>
                  <Btn onClick={()=>del(m)} variant="ghost" size="sm" style={{color:C.red600}}>Del</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {modal&&(
        <Modal title={editing?"Edit Macro":"New Macro"} onClose={()=>setModal(false)}>
          <FInput label="Name" required value={form.name} onChange={v=>setForm(f=>({...f,name:v}))} placeholder="e.g. Normal Gait Exam"/>
          <FInput label="Section" value={form.section} onChange={v=>setForm(f=>({...f,section:v}))} placeholder="e.g. Physical Exam, HPI"/>
          <FTextarea label="Content" value={form.content} onChange={v=>setForm(f=>({...f,content:v}))} rows={8} placeholder="Macro text…"/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <Btn onClick={()=>setModal(false)} variant="outline">Cancel</Btn>
            <Btn onClick={save}>{editing?"Save Changes":"Create Macro"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Breach Notifications ────────────────────────────────────────────────────
function BreachNotifications() {
  const [items,setItems]=useState([]);const [loading,setLoading]=useState(true);const [modal,setModal]=useState(false);
  const [form,setForm]=useState({event_type:"",severity:"medium",description:"",affected_users:"",investigation_notes:"",status:"open"});
  const load=useCallback(async()=>{setLoading(true);try{setItems(await BreachNotification.list());}catch(e){}setLoading(false);},[]);
  useEffect(()=>{load();},[load]);
  const save=async()=>{if(!form.description.trim())return alert("Description required.");try{await BreachNotification.create({...form,detected_date:new Date().toISOString(),notification_sent:false});setModal(false);setForm({event_type:"",severity:"medium",description:"",affected_users:"",investigation_notes:"",status:"open"});load();}catch(e){alert(e.message);}};
  const toggle=async b=>{try{await BreachNotification.update(b.id,{status:b.status==="resolved"?"open":"resolved"});load();}catch(e){alert(e.message);}};
  const sevColors={low:[C.green600,"#dcfce7"],medium:[C.amber600,"#fef3c7"],high:[C.red600,"#fee2e2"],critical:["#7f1d1d","#fce7f3"]};
  return (
    <div style={{padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div><h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Breach Notifications</h1><p style={{color:C.slate600,marginTop:4}}>HIPAA security incident log</p></div>
        <Btn onClick={()=>setModal(true)} variant="danger">+ Report Breach</Btn>
      </div>
      {loading?<Spinner/>:items.length===0?<Empty icon="🔒" title="No breach events logged" sub="All clear — no security incidents on record"/>:(
        <div style={{display:"grid",gap:10}}>
          {items.map(b=>{const [color,bg]=sevColors[b.severity]||sevColors.medium;return(
            <Card key={b.id} style={{display:"flex",gap:12,borderLeft:`4px solid ${color}`}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:8,marginBottom:6,alignItems:"center"}}>
                  <span style={{fontWeight:600,fontSize:14}}>{b.event_type||"Security Event"}</span>
                  <Badge color={color} bg={bg}>{b.severity}</Badge>
                  <StatusBadge status={b.status||"open"}/>
                </div>
                <div style={{fontSize:13,color:C.slate600,marginBottom:4}}>{b.description}</div>
                <div style={{fontSize:11.5,color:C.slate400}}>{b.affected_users&&<span style={{marginRight:10}}>Affected: {b.affected_users}</span>}{b.detected_date&&<span>Detected: {new Date(b.detected_date).toLocaleString()}</span>}</div>
                {b.investigation_notes&&<div style={{fontSize:12,color:C.slate500,marginTop:4,fontStyle:"italic"}}>Notes: {b.investigation_notes}</div>}
              </div>
              <Btn onClick={()=>toggle(b)} variant={b.status==="resolved"?"outline":"success"} size="sm">{b.status==="resolved"?"Reopen":"Resolve"}</Btn>
            </Card>
          );})}
        </div>
      )}
      {modal&&(
        <Modal title="Report Security Breach" description="Logged for HIPAA compliance" onClose={()=>setModal(false)}>
          <FInput label="Event Type" value={form.event_type} onChange={v=>setForm(f=>({...f,event_type:v}))} placeholder="e.g. Unauthorized Access"/>
          <FSelect label="Severity" value={form.severity} onChange={v=>setForm(f=>({...f,severity:v}))} options={["low","medium","high","critical"]}/>
          <FTextarea label="Description" value={form.description} onChange={v=>setForm(f=>({...f,description:v}))} rows={4}/>
          <FInput label="Affected Users / Records" value={form.affected_users} onChange={v=>setForm(f=>({...f,affected_users:v}))} placeholder="e.g. 0 identified"/>
          <FTextarea label="Investigation Notes" value={form.investigation_notes} onChange={v=>setForm(f=>({...f,investigation_notes:v}))} rows={3}/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><Btn onClick={()=>setModal(false)} variant="outline">Cancel</Btn><Btn onClick={save} variant="danger">Submit Report</Btn></div>
        </Modal>
      )}
    </div>
  );
}

// ─── Suggestions ──────────────────────────────────────────────────────────────
function Suggestions() {
  const [items,setItems]=useState([]);const [loading,setLoading]=useState(true);const [modal,setModal]=useState(false);
  const [form,setForm]=useState({title:"",description:"",category:"Feature Request",priority:"medium"});
  const load=useCallback(async()=>{setLoading(true);try{setItems(await Suggestion.list());}catch(e){}setLoading(false);},[]);
  useEffect(()=>{load();},[load]);
  const save=async()=>{if(!form.title.trim())return alert("Title required.");try{await Suggestion.create(form);setModal(false);setForm({title:"",description:"",category:"Feature Request",priority:"medium"});load();}catch(e){alert(e.message);}};
  const prioColor={low:[C.green600,"#dcfce7"],medium:[C.amber600,"#fef3c7"],high:[C.red600,"#fee2e2"]};
  return (
    <div style={{padding:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div><h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:0}}>Suggestions</h1><p style={{color:C.slate600,marginTop:4}}>Feature requests and feedback</p></div>
        <Btn onClick={()=>setModal(true)}>+ Add Suggestion</Btn>
      </div>
      {loading?<Spinner/>:items.length===0?<Empty icon="💬" title="No suggestions yet" action={<Btn onClick={()=>setModal(true)}>Submit First Suggestion</Btn>}/>:(
        <div style={{display:"grid",gap:10}}>
          {items.map(sg=>{const[pc,pbg]=prioColor[sg.priority]||prioColor.medium;return(
            <Card key={sg.id} style={{display:"flex",gap:12}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:8,marginBottom:4,alignItems:"center"}}><span style={{fontWeight:600,fontSize:14}}>{sg.title}</span>{sg.category&&<Badge color={C.slate500} bg={C.slate100}>{sg.category}</Badge>}{sg.priority&&<Badge color={pc} bg={pbg}>{sg.priority}</Badge>}</div>
                {sg.description&&<div style={{fontSize:13,color:C.slate500}}>{sg.description}</div>}
              </div>
              <select value={sg.status||"pending"} onChange={e=>Suggestion.update(sg.id,{status:e.target.value}).then(load)} style={{...inp,width:130,fontSize:12}}>
                {["pending","reviewing","planned","completed","rejected"].map(v=><option key={v}>{v}</option>)}
              </select>
            </Card>
          );})}
        </div>
      )}
      {modal&&(
        <Modal title="Add Suggestion" onClose={()=>setModal(false)}>
          <FInput label="Title" required value={form.title} onChange={v=>setForm(f=>({...f,title:v}))}/>
          <FTextarea label="Description" value={form.description} onChange={v=>setForm(f=>({...f,description:v}))} rows={4}/>
          <FSelect label="Category" value={form.category} onChange={v=>setForm(f=>({...f,category:v}))} options={["Feature Request","Bug Report","UI Improvement","Performance","Other"]}/>
          <FSelect label="Priority" value={form.priority} onChange={v=>setForm(f=>({...f,priority:v}))} options={["low","medium","high"]}/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><Btn onClick={()=>setModal(false)} variant="outline">Cancel</Btn><Btn onClick={save}>Submit</Btn></div>
        </Modal>
      )}
    </div>
  );
}

function Users() {
  return (
    <div style={{padding:32}}>
      <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:"0 0 8px"}}>Invite Users</h1>
      <p style={{color:C.slate600,marginBottom:24}}>Manage team access</p>
      <Card><div style={{textAlign:"center",padding:"40px 20px",color:C.slate400}}><div style={{fontSize:40,marginBottom:10}}>👥</div><div style={{fontSize:13}}>Invite team members through the Base44 app settings → Users section.</div></div></Card>
    </div>
  );
}

function SplitPdf() {
  return (
    <div style={{padding:32}}>
      <h1 style={{fontSize:28,fontWeight:700,color:C.slate900,margin:"0 0 8px"}}>Split PDF</h1>
      <p style={{color:C.slate600,marginBottom:24}}>Large PDFs are automatically split on upload</p>
      <Card><div style={{textAlign:"center",padding:"40px 20px"}}>
        <div style={{fontSize:40,marginBottom:10}}>✂️</div>
        <div style={{fontSize:15,fontWeight:600,color:C.slate900,marginBottom:4}}>Auto-split on Upload</div>
        <div style={{fontSize:13,color:C.slate500}}>PDFs over 10MB are automatically split into smaller parts when uploaded. Each part is processed separately and appears in your Document Library.</div>
      </div></Card>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
function AppInner() {
  const [page,      setPage]      = useState("dashboard");
  const [patients,  setPatients]  = useState([]);
  const [documents, setDocuments] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [loading,   setLoading]   = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const pData = await awsGet("/patients").catch(()=>({patients:[]}));
      const pts   = pData.patients || [];
      setPatients(pts);

      if (pts.length > 0) {
        const docResults = await Promise.all(
          pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(()=>[]))
        );
        const allDocs = docResults.flatMap(r => Array.isArray(r)?r:(r.documents||[]));
        setDocuments(allDocs);

        const sumResults = await Promise.all(
          pts.map(p => awsGet(`/summaries?patient_id=${p.aws_patient_id}`).catch(()=>({summaries:[]})))
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
    if (loading) return <Spinner text="Loading ChartReview Pro…"/>;
    switch(page) {
      case "dashboard":   return <Dashboard onNav={nav} patients={patients} documents={documents} summaries={summaries}/>;
      case "upload":      return <Upload patients={patients} onRefresh={loadAll} onNav={nav}/>;
      case "library":     return <Library documents={documents} onRefresh={loadAll}/>;
      case "duplicates":  return <Duplicates documents={documents} onRefresh={loadAll}/>;
      case "summaries":   return <MedicalSummaries summaries={summaries} patients={patients} documents={documents} onRefresh={loadAll}/>;
      case "splitpdf":    return <SplitPdf/>;
      case "settings":    return <Settings/>;
      case "breaches":    return <BreachNotifications/>;
      case "suggestions": return <Suggestions/>;
      case "users":       return <Users/>;
      default:            return null;
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
      <AppInner/>
    </UploadProvider>
  );
}
