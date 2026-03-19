import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle, XCircle, X } from "lucide-react";

const SummaryGenerationContext = createContext();

export const useSummaryGeneration = () => {
  const context = useContext(SummaryGenerationContext);
  if (!context) throw new Error("useSummaryGeneration must be used within SummaryGenerationProvider");
  return context;
};

export const SummaryGenerationProvider = ({ children }) => {
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState([]); // [{ id, label, status: 'running'|'done'|'error', message }]
  const isEditingRef = useRef(false); // true when user has a summary edit dialog open
  const pendingInvalidateRef = useRef(false); // tracks if we need to invalidate after edit closes

  const setEditing = useCallback((editing) => {
    isEditingRef.current = editing;
    // If edit session just closed and there's a pending invalidation, fire it now
    if (!editing && pendingInvalidateRef.current) {
      pendingInvalidateRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["summaries"] });
      queryClient.refetchQueries({ queryKey: ["summaries"] });
    }
  }, [queryClient]);

  const addJob = (id, label) => {
    setJobs(prev => [...prev, { id, label, status: "running", message: "" }]);
  };
  const updateJob = (id, update) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...update } : j));
  };
  const removeJob = (id) => {
    setJobs(prev => prev.filter(j => j.id !== id));
  };

  const runGenerationPerDoc = useCallback(async ({ selectedDocs, runAiBatch, sanitizeVisits, deduplicateVisits }) => {
    // Generate one summary per document, then combine them all
    const jobId = Math.random().toString(36).substr(2, 9);
    const label = `${selectedDocs.length} docs (one-by-one → combined)`;
    addJob(jobId, label);

    try {
      const individualSummaries = [];

      for (let i = 0; i < selectedDocs.length; i++) {
        const doc = selectedDocs[i];
        updateJob(jobId, { message: `Processing doc ${i + 1}/${selectedDocs.length}: ${doc.title}` });

        const aiResult = await runAiBatch([doc], 1);
        const sanitized = sanitizeVisits(aiResult.visits, aiResult.patient_name);

        if (sanitized.length > 0) {
          individualSummaries.push({
            patientName: aiResult.patient_name || doc.patient_name || '',
            caseNumber: aiResult.case_number || doc.case_number || '',
            docId: doc.id,
            visits: sanitized,
          });
        }
      }

      if (individualSummaries.length === 0) {
        throw new Error("No medical visits were extracted from any of the documents.");
      }

      // Combine all visits
      updateJob(jobId, { message: `Combining ${individualSummaries.length} results...` });

      let allVisits = individualSummaries.flatMap(s => s.visits);

      // Sort chronologically
      allVisits.sort((a, b) => {
        if (!a.visit_date) return 1;
        if (!b.visit_date) return -1;
        const diff = new Date(a.visit_date) - new Date(b.visit_date);
        if (diff !== 0) return diff;
        const aIsC4 = (a.practice_setting || "").toLowerCase().includes("c-4");
        const bIsC4 = (b.practice_setting || "").toLowerCase().includes("c-4");
        if (aIsC4 && !bIsC4) return -1;
        if (!aIsC4 && bIsC4) return 1;
        return 0;
      });

      allVisits = deduplicateVisits(allVisits);

      // Deduplicate imaging findings
      const imagingUsed = new Set();
      allVisits = allVisits.map(visit => {
        if (visit.imaging_findings?.trim()) {
          const key = visit.imaging_findings.trim().toLowerCase();
          if (imagingUsed.has(key)) return { ...visit, imaging_findings: "" };
          imagingUsed.add(key);
        }
        return visit;
      });

      const base = individualSummaries[0];
      const summaryData = {
        document_id: selectedDocs.map(d => d.id).join(","),
        patient_name: base.patientName || selectedDocs[0].patient_name || "Unknown Patient",
        case_number: base.caseNumber || selectedDocs[0].case_number || "",
        visits: allVisits,
        status: "draft",
        notes: `Combined summary from ${selectedDocs.length} documents (generated one-by-one): ${selectedDocs.map(d => d.title).join(", ")}`,
      };

      const newSummary = await base44.entities.MedicalSummary.create(summaryData);
      if (!newSummary?.id) throw new Error("Failed to create summary in database.");

      if (isEditingRef.current) {
        pendingInvalidateRef.current = true;
      } else {
        await queryClient.invalidateQueries({ queryKey: ["summaries"] });
        await queryClient.refetchQueries({ queryKey: ["summaries"] });
      }

      updateJob(jobId, { status: "done", message: `${base.patientName || "Summary"} ready (${allVisits.length} visits)`, result: newSummary });
      return { success: true, summary: newSummary };
    } catch (err) {
      const msg = err?.message || "Failed to generate summary.";
      updateJob(jobId, { status: "error", message: msg });
      return { success: false, error: msg };
    }
  }, [queryClient]);

  const runGeneration = useCallback(async ({ selectedDocs, runAiBatch, sanitizeVisits, deduplicateVisits }) => {
    const jobId = Math.random().toString(36).substr(2, 9);
    const label = selectedDocs.length === 1
      ? selectedDocs[0].patient_name || selectedDocs[0].title
      : `${selectedDocs.length} documents`;
    addJob(jobId, label);

    try {
      // Build batches dynamically: cap each batch at ~50MB total file size, max 5 docs
      const MAX_BATCH_BYTES = 50 * 1024 * 1024;
      const MAX_BATCH_DOCS = 5;
      const batches = [];
      let currentBatch = [];
      let currentSize = 0;
      for (const doc of selectedDocs) {
        const docSize = doc.file_size || 0;
        if (currentBatch.length > 0 && (currentSize + docSize > MAX_BATCH_BYTES || currentBatch.length >= MAX_BATCH_DOCS)) {
          batches.push(currentBatch);
          currentBatch = [];
          currentSize = 0;
        }
        currentBatch.push(doc);
        currentSize += docSize;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      let allVisits = [];
      let patientName = "";
      let caseNumber = "";

      // Process all batches in parallel
      const batchPromises = batches.map((batch, batchIdx) => 
        runAiBatch(batch, selectedDocs.length).then(aiResult => ({
          batchIdx,
          aiResult,
          sanitized: sanitizeVisits(aiResult.visits, aiResult.patient_name)
        }))
      );

      const batchResults = await Promise.all(batchPromises);
      
      for (const { batchIdx, aiResult, sanitized } of batchResults) {
        updateJob(jobId, { message: `Processing batch ${batchIdx + 1}/${batches.length}` });
        if (!patientName && aiResult.patient_name) patientName = aiResult.patient_name;
        if (!caseNumber && aiResult.case_number) caseNumber = aiResult.case_number;
        allVisits = allVisits.concat(sanitized);
      }

      if (allVisits.length === 0) throw new Error("No medical visits were extracted from the documents.");

      // Sort chronologically; C-4 entries before same-date visits
      allVisits.sort((a, b) => {
        if (!a.visit_date) return 1;
        if (!b.visit_date) return -1;
        const diff = new Date(a.visit_date) - new Date(b.visit_date);
        if (diff !== 0) return diff;
        const aIsC4 = (a.practice_setting || "").toLowerCase().includes("c-4");
        const bIsC4 = (b.practice_setting || "").toLowerCase().includes("c-4");
        if (aIsC4 && !bIsC4) return -1;
        if (!aIsC4 && bIsC4) return 1;
        return 0;
      });

      allVisits = deduplicateVisits(allVisits);

      // Deduplicate imaging findings across batches
      const imagingUsed = new Set();
      allVisits = allVisits.map(visit => {
        if (visit.imaging_findings?.trim()) {
          const key = visit.imaging_findings.trim().toLowerCase();
          if (imagingUsed.has(key)) return { ...visit, imaging_findings: "" };
          imagingUsed.add(key);
        }
        return visit;
      });

      const summaryData = {
        document_id: selectedDocs.map(d => d.id).join(","),
        patient_name: patientName || selectedDocs[0].patient_name || "Unknown Patient",
        case_number: caseNumber || selectedDocs[0].case_number || "",
        visits: allVisits,
        status: "draft",
        notes: selectedDocs.length > 1
          ? `Combined summary from ${selectedDocs.length} documents: ${selectedDocs.map(d => d.title).join(", ")}`
          : undefined,
      };

      const newSummary = await base44.entities.MedicalSummary.create(summaryData);
      if (!newSummary?.id) throw new Error("Failed to create summary in database.");

      if (isEditingRef.current) {
        // Defer invalidation until the editing session closes
        pendingInvalidateRef.current = true;
      } else {
        await queryClient.invalidateQueries({ queryKey: ["summaries"] });
        await queryClient.refetchQueries({ queryKey: ["summaries"] });
      }

      updateJob(jobId, { status: "done", message: `${patientName || "Summary"} ready`, result: newSummary });
      return { success: true, summary: newSummary };
    } catch (err) {
      const msg = err?.message || "Failed to generate summary.";
      updateJob(jobId, { status: "error", message: msg });
      return { success: false, error: msg };
    }
  }, [queryClient]);

  return (
    <SummaryGenerationContext.Provider value={{ jobs, runGeneration, runGenerationPerDoc, removeJob, setEditing }}>
      {children}
      <SummaryGenerationToast jobs={jobs} removeJob={removeJob} />
    </SummaryGenerationContext.Provider>
  );
};

function SummaryGenerationToast({ jobs, removeJob }) {
  if (jobs.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm">
      {jobs.map(job => (
        <div
          key={job.id}
          className={`flex items-start gap-3 p-4 rounded-xl shadow-lg border text-sm
            ${job.status === "done" ? "bg-green-50 border-green-200 text-green-900"
              : job.status === "error" ? "bg-red-50 border-red-200 text-red-900"
              : "bg-white border-slate-200 text-slate-900"}`}
        >
          <div className="mt-0.5 shrink-0">
            {job.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
            {job.status === "done" && <CheckCircle className="w-4 h-4 text-green-600" />}
            {job.status === "error" && <XCircle className="w-4 h-4 text-red-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{job.label}</p>
            <p className="text-xs mt-0.5 opacity-75">{job.message || (job.status === "running" ? "Analyzing documents..." : "")}</p>
          </div>
          {job.status !== "running" && (
            <button onClick={() => removeJob(job.id)} className="shrink-0 opacity-50 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}