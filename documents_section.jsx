function Documents() {
  const [allDocuments, setAllDocuments] = useState([]);
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [filterName, setFilterName] = useState("");
  const [uploadForm, setUploadForm] = useState({ patient_id: "", patient_name_free: "", title: "", category: "Medical Records" });
  const [file, setFile] = useState(null);
  const [processing, setProcessing] = useState({});

  const categories = ["Medical Records", "Imaging", "Lab Results", "Operative Notes", "Discharge Summary", "Consultation", "Physical Therapy", "Mental Health", "Legal", "Other"];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const pData = await awsGet("/patients").catch(() => ({ patients: [] }));
      const pts = pData.patients || [];
      setPatients(pts);

      // Fetch documents for all patients in parallel
      const docResults = await Promise.all(
        pts.map(p => awsGet(`/patients/${p.aws_patient_id}/documents`).catch(() => []))
      );
      const allDocs = docResults.flat();
      setAllDocuments(allDocs);
    } catch (e) {
      console.error("load error", e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const uploadDoc = async () => {
    if (!file) return alert("Please select a file.");
    const selectedPatient = patients.find(p => p.aws_patient_id === uploadForm.patient_id);
    const patientName = selectedPatient ? selectedPatient.patient_name : uploadForm.patient_name_free.trim();
    if (!patientName) return alert("Please select or enter a patient name.");

    setUploading(true);
    try {
      // Step 1: Use existing patient ID or create new patient
      let awsPatientId = selectedPatient ? selectedPatient.aws_patient_id : null;
      if (!awsPatientId) {
        try {
          const pRes = await awsPost("/patients", { patient_name: patientName });
          awsPatientId = pRes?.aws_patient_id || null;
        } catch (e) {
          alert("Upload failed at Step 1 (create patient): " + e.message);
          setUploading(false); return;
        }
      }

      // Step 2: Get presigned S3 upload URL
      let uploadData;
      try {
        const docPayload = {
          aws_patient_id: awsPatientId,
          patient_name: patientName,
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          title: uploadForm.title || file.name,
          category: uploadForm.category,
        };
        uploadData = await awsPost("/documents/upload-url", docPayload);
        if (!uploadData.upload_url) throw new Error("No upload_url in response");
      } catch (e) {
        alert("Upload failed at Step 2 (get upload URL): " + e.message);
        setUploading(false); return;
      }

      // Step 3: Upload directly to S3
      try {
        const s3Res = await fetch(uploadData.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" }
        });
        if (!s3Res.ok) throw new Error("S3 upload failed: " + s3Res.status);
      } catch (e) {
        alert("Upload failed at Step 3 (S3 PUT): " + e.message);
        setUploading(false); return;
      }

      // Step 4: Trigger AI processing
      try {
        await awsPost(`/documents/${uploadData.aws_document_id}/process`, {});
      } catch (e) {
        console.warn("Processing trigger failed (non-fatal):", e.message);
      }

      alert("Document uploaded! AI summary is being generated — check back in a moment.");
      setShowUpload(false);
      setFile(null);
      setUploadForm({ patient_id: "", patient_name_free: "", title: "", category: "Medical Records" });
      await load();
    } catch (e) {
      alert("Upload failed: " + e.message);
    }
    setUploading(false);
  };

  const processDoc = async (doc) => {
    setProcessing(p => ({ ...p, [doc.aws_document_id]: true }));
    try {
      const res = await awsPost(`/documents/${doc.aws_document_id}/process`, {});
      alert("Processing complete!\n\n" + (res.summary ? res.summary.substring(0, 400) + "..." : "Summary saved."));
      await load();
    } catch (e) {
      alert("Processing failed: " + e.message);
    }
    setProcessing(p => ({ ...p, [doc.aws_document_id]: false }));
  };

  const filtered = allDocuments.filter(d =>
    !filterName || (d.patient_name || d.title || d.file_name || "").toLowerCase().includes(filterName.toLowerCase())
  );

  const statusBadge = (status) => {
    const map = {
      uploaded: { text: "Uploaded", color: "#64748b", bg: "#f1f5f9" },
      processing: { text: "Processing", color: "#d97706", bg: "#fef3c7" },
      processed: { text: "Processed ✓", color: "#10b981", bg: "#d1fae5" },
      failed: { text: "Failed", color: "#ef4444", bg: "#fee2e2" },
    };
    const s = map[status] || map.uploaded;
    return <Badge text={s.text} color={s.color} bg={s.bg} />;
  };

  return (
    <div style={{ padding: 32 }}>
      <PageHeader title="Documents" subtitle="Upload and manage medical documents"
        action={<Btn onClick={() => setShowUpload(true)}>+ Upload Document</Btn>} />

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input value={filterName} onChange={e => setFilterName(e.target.value)}
            placeholder="Filter by patient name or title..."
            style={{ flex: 1, padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, outline: "none" }} />
          <Btn onClick={load} variant="secondary">↻ Refresh</Btn>
          {filterName && <Btn onClick={() => setFilterName("")} variant="secondary">Clear</Btn>}
        </div>
      </Card>

      {loading ? <Loading /> : allDocuments.length === 0 ? (
        <Empty message="No documents uploaded yet"
          action={<Btn onClick={() => setShowUpload(true)}>Upload First Document</Btn>} />
      ) : filtered.length === 0 ? (
        <Empty message={"No documents matching \"" + filterName + "\""} action={<Btn onClick={() => setFilterName("")} variant="secondary">Clear Filter</Btn>} />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {filtered.map(d => (
            <Card key={d.aws_document_id}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 28 }}>📄</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{d.title || d.file_name}</div>
                  <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
                    {d.patient_name && <span style={{ marginRight: 8 }}>👤 {d.patient_name}</span>}
                    {d.category && <span style={{ marginRight: 8 }}>{d.category}</span>}
                    {statusBadge(d.status)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {d.status !== "processed" && (
                    <Btn onClick={() => processDoc(d)} variant="secondary" disabled={processing[d.aws_document_id]}>
                      {processing[d.aws_document_id] ? "Processing..." : "⚡ Process"}
                    </Btn>
                  )}
                  <Btn onClick={() => setSelectedDoc(d)} variant="secondary">View</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showUpload && (
        <Modal title="Upload Document" onClose={() => { setShowUpload(false); setFile(null); }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>
              Patient <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <select value={uploadForm.patient_id} onChange={e => setUploadForm(f => ({ ...f, patient_id: e.target.value, patient_name_free: "" }))}
              style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box", marginBottom: 8 }}>
              <option value="">— Select existing patient —</option>
              {patients.map(p => <option key={p.aws_patient_id} value={p.aws_patient_id}>{p.patient_name}</option>)}
            </select>
            {!uploadForm.patient_id && (
              <input value={uploadForm.patient_name_free} onChange={e => setUploadForm(f => ({ ...f, patient_name_free: e.target.value }))}
                placeholder="Or type a new patient name..."
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }} />
            )}
          </div>
          <Input label="Document Title" value={uploadForm.title} onChange={v => setUploadForm(f => ({ ...f, title: v }))} placeholder="Leave blank to use filename" />
          <Select label="Category" value={uploadForm.category} onChange={v => setUploadForm(f => ({ ...f, category: v }))}
            options={categories.map(c => ({ value: c, label: c }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>File <span style={{ color: "#ef4444" }}>*</span></label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.tiff" onChange={e => setFile(e.target.files[0])} style={{ fontSize: 14 }} />
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={() => { setShowUpload(false); setFile(null); }} variant="secondary">Cancel</Btn>
            <Btn onClick={uploadDoc} disabled={uploading}>{uploading ? "Uploading..." : "Upload"}</Btn>
          </div>
        </Modal>
      )}

      {selectedDoc && (
        <Modal title={selectedDoc.title || selectedDoc.file_name} onClose={() => setSelectedDoc(null)} width={700}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Patient</span><div style={{ fontWeight: 500 }}>{selectedDoc.patient_name || "—"}</div></div>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Category</span><div style={{ fontWeight: 500 }}>{selectedDoc.category || "—"}</div></div>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Status</span><div>{statusBadge(selectedDoc.status)}</div></div>
            <div><span style={{ fontSize: 12, color: "#64748b" }}>Uploaded</span><div style={{ fontWeight: 500 }}>{selectedDoc.created_at ? new Date(selectedDoc.created_at).toLocaleDateString() : "—"}</div></div>
          </div>
          {selectedDoc.aws_summary_id && (
            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#166534", marginBottom: 4 }}>✓ AI Summary Generated</div>
              <div style={{ fontSize: 13, color: "#166534" }}>Summary ID: {selectedDoc.aws_summary_id}</div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {selectedDoc.status !== "processed" && (
              <Btn onClick={() => { processDoc(selectedDoc); setSelectedDoc(null); }} variant="success">⚡ Generate Summary</Btn>
            )}
            <Btn onClick={async () => {
              try {
                const r = await awsGet(`/documents/${selectedDoc.aws_document_id}/download-url`);
                window.open(r.download_url, "_blank");
              } catch (e) { alert("Download failed: " + e.message); }
            }} variant="secondary">⬇ Download</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

