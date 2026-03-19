import React, { useState } from "react";
import { useSummaryGeneration } from "@/components/SummaryGenerationManager";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileCheck,
  Plus,
  Download,
  Edit,
  Eye,
  Loader2,
  Sparkles,
  Trash2,
  CheckSquare,
  Square,
  Users,
  AlertCircle,
  Folder,
  Merge,
  Filter
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import MedicalSummaryForm from "../components/summaries/MedicalSummaryForm";
import SummaryViewer from "../components/summaries/SummaryViewer";

export default function MedicalSummaries() {
  const queryClient = useQueryClient();
  const [selectedDocuments, setSelectedDocuments] = useState([]);
  const [generatingSummary] = useState(false);
  const [viewingSummary, setViewingSummary] = useState(null);
  const [editingSummary, setEditingSummary] = useState(null);
  const [deleteSummary, setDeleteSummary] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showCombineDialog, setShowCombineDialog] = useState(false);
  const [selectedSummariesToCombine, setSelectedSummariesToCombine] = useState([]);
  const [error, setError] = useState(null);
  const { data: documents = [] } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list('-created_date'),
    initialData: [],
  });

  const { data: summaries = [], isLoading: summariesLoading } = useQuery({
    queryKey: ['summaries'],
    queryFn: () => base44.entities.MedicalSummary.list('-created_date'),
    initialData: [],
    refetchOnWindowFocus: false,
  });

  // Get unique folders from documents
  const folders = [...new Set(documents.map(d => d.folder).filter(Boolean))].sort();
  const unfiledCount = documents.filter(d => !d.folder).length;

  const [deleteAllDialog, setDeleteAllDialog] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.MedicalSummary.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      setDeleteSummary(null);
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(summaries.map(s => base44.entities.MedicalSummary.delete(s.id)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      setDeleteAllDialog(false);
    },
  });

  // Deduplicates visits by date + provider + setting (exact match = true duplicate, removed).
  // Additionally, for visits sharing date + setting but with DIFFERENT providers,
  // annotates the primary visit's provider with "Supervising Provider: [name]".
  const deduplicateVisits = (visits) => {
    const visitList = visits || [];

    // Step 1: Remove exact duplicates (same date + provider + setting)
    const exactKeys = new Set();
    const deduped = visitList.filter((visit, idx) => {
      const dateKey = (visit.visit_date || '').trim().toLowerCase();
      const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
      const settingKey = (visit.practice_setting || '').trim().toLowerCase();
      if (!dateKey && !providerKey) return true; // no identifying info, keep
      const key = `${dateKey}|${providerKey}|${settingKey}`;
      if (exactKeys.has(key)) return false;
      exactKeys.add(key);
      return true;
    });

    return deduped;
  };

  const deduplicateMutation = useMutation({
    mutationFn: async (summary) => {
      const deduped = deduplicateVisits(summary.visits);
      const removed = (summary.visits || []).length - deduped.length;
      await base44.entities.MedicalSummary.update(summary.id, { visits: deduped });
      return { removed };
    },
    onSuccess: (result, summary) => {
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      alert(result.removed > 0
        ? `Merged/removed ${result.removed} duplicate visit(s) from ${summary.patient_name || 'this summary'}.`
        : `No duplicate visits found in ${summary.patient_name || 'this summary'}.`
      );
    },
  });

  // Group all documents by folder
  const documentsByFolder = documents.reduce((acc, doc) => {
    const folderKey = doc.folder || 'Unfiled';
    if (!acc[folderKey]) {
      acc[folderKey] = [];
    }
    acc[folderKey].push(doc);
    return acc;
  }, {});

  // Shared helpers for provider normalization and part number extraction
  const normalizeProviderName = (name) => {
    return (name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+and\s+rehabilitation\b/gi, '')
      .replace(/\s+rehabilitation\b/gi, '')
      .replace(/\s+center\b/gi, '')
      .replace(/\s+clinic\b/gi, '')
      .replace(/\s+medical\s+group\b/gi, '')
      .replace(/\s+associates\b/gi, '')
      .replace(/\s+hospital\b/gi, '')
      .replace(/\s+health\s*care\b/gi, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  };

  const getPartNumber = (title) => {
    const stem = title.replace(/\.[^.]+$/, '');
    const patterns = [
      /part[_\-\s]*(\d+)/i,
      /[_\-\s](\d+)$/,
      /\((\d+)\)$/,
      /(\d+)$/
    ];
    for (const p of patterns) {
      const m = stem.match(p);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  // Group documents by facility/provider within each folder
  const documentGroups = documents.reduce((groups, doc) => {
    const providerName = doc.provider_name || 'Unknown Facility';
    const normalizedKey = normalizeProviderName(providerName) || 'unknown';
    if (!groups[normalizedKey]) {
      groups[normalizedKey] = { displayName: providerName, docs: [] };
    }
    groups[normalizedKey].docs.push(doc);
    return groups;
  }, {});

  // Sort documents within each group numerically by part number, then alphabetically
  Object.keys(documentGroups).forEach(key => {
    documentGroups[key].docs.sort((a, b) => {
      const numA = getPartNumber(a.title);
      const numB = getPartNumber(b.title);
      if (numA !== null && numB !== null) return numA - numB;
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      return a.title.localeCompare(b.title);
    });
  });

  const toggleDocumentSelection = (docId) => {
    setSelectedDocuments(prev =>
      prev.includes(docId)
        ? prev.filter(id => id !== docId)
        : [...prev, docId]
    );
  };

  const selectGroup = (groupDocs) => {
    const groupIds = groupDocs.map(d => d.id);
    setSelectedDocuments(prev => {
      const allSelectedInGroup = groupIds.every(id => prev.includes(id));
      if (allSelectedInGroup) {
        // If all are selected, deselect them
        return prev.filter(id => !groupIds.includes(id));
      } else {
        // Otherwise, select all in the group (add new ones, keep existing)
        return [...new Set([...prev, ...groupIds])];
      }
    });
  };

  const { runGeneration, runGenerationPerDoc, setEditing } = useSummaryGeneration();
  const [queueProgress, setQueueProgress] = useState(null); // {current, total, status}
  const [generateMode, setGenerateMode] = useState('batch'); // 'batch' | 'one-by-one'



  const runAiBatch = async (docs, totalDocs = null) => {
    const MAX_SINGLE_MB = 20;
    // For large docs, use a short excerpt of extracted text instead of full text to avoid timeouts
    const largeDocText = docs
      .filter(doc => (doc.file_size || 0) / (1024 * 1024) > MAX_SINGLE_MB)
      .map(doc => {
        const excerpt = (doc.extracted_text || '[No text available]').substring(0, 3000);
        return `--- DOCUMENT: ${doc.title} ---\n${excerpt}\n[...truncated for brevity...]`;
      })
      .join('\n\n');
    const docContextSection = largeDocText.trim()
      ? `\nLARGE DOCUMENT CONTENT (file too large to attach directly):\n${largeDocText}\n`
      : '';
    const fileUrls = docs.filter(d => (d.file_size || 0) / (1024 * 1024) <= MAX_SINGLE_MB).map(d => d.file_url);
    const total = totalDocs || docs.length;

    const prompt = `You are a medical-legal document analyst. Analyze these ${docs.length} medical document(s) and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.
${docContextSection}

${total > 1 ? `CRITICAL: You are analyzing ${docs.length} documents (part of a larger set of ${total}) which may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.` : ''}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    Examples of what to extract:
    - If document says "Smith Family Medical Group", use "Smith Family Medical Group" as practice_setting
    - If from "XYZ Orthopedic Associates", use "XYZ Orthopedic Associates" 
    - If from "Community Hospital Emergency Department", use "Community Hospital Emergency Department"
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section

B) EXPERT MEDICAL REPORTS / INDEPENDENT MEDICAL EXAMINATIONS (IME) / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize — use the specific type stated. Examples:
   - If the document says "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - If the document says "Consultation Report" or "Consultative Evaluation" → practice_setting: "Consultation Report"
   - If the document says "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - If the document says "Radiology Report", "MRI Report", "X-Ray Report", "CT Report" → practice_setting: "Radiology Report" (or the specific modality, e.g., "MRI Report")
   - If the document says "Narrative Report" or "Narrative Summary" → practice_setting: "Narrative Report"
   - If the document says "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - If the document says "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   - If none of the above apply, use the most accurate label based on what is stated in the document header or title
   NEVER default to "Independent Medical Examination" unless those exact words (or "IME") appear in the document.
   For all of these types:
   - rendering_provider: the expert/reviewing physician's name
   - chief_complaint: the stated purpose of the report
   - hpi_summary: the expert's review of history and background as summarized in the report
   - physical_exam_findings: examination findings if the expert physically examined the patient, otherwise leave empty
   - impression_diagnosis: the expert's opinions, conclusions, and diagnoses
   - treatment_plan: the expert's recommendations or causation opinions
   - imaging_findings: any imaging reviewed or interpreted by the expert
   - visit_date: the date the report was authored or the examination was performed

C) POLICE REPORTS:
   Treat as a single entry with:
   - rendering_provider: the reporting officer's name and badge number if available
   - practice_setting: "Police Report"
   - chief_complaint: the incident type (e.g., "Motor Vehicle Collision", "Incident Report")
   - hpi_summary: narrative description of the incident — how it occurred, parties involved, witness statements, road/weather conditions, and any citations issued. Summarize concisely.
   - physical_exam_findings: any observations about injuries noted by the officer at the scene
   - impression_diagnosis: officer's conclusions, fault determination, or citations issued
   - treatment_plan: any emergency services dispatched or recommended at scene
   - visit_date: the date of the incident or report

D) AMBULANCE / EMS REPORTS (pre-hospital care records):
   Treat as a single entry with:
   - rendering_provider: the paramedic/EMT name or unit number
   - practice_setting: "Ambulance / EMS Report"
   - chief_complaint: the patient's chief complaint at the scene
   - hpi_summary: mechanism of injury, scene description, patient condition on arrival, and patient's reported symptoms. Summarize concisely.
   - physical_exam_findings: vital signs (BP, HR, RR, O2 sat, GCS), physical findings, and neurological status at scene
   - impression_diagnosis: EMS impression/working diagnosis
   - treatment_plan: treatment administered on scene and during transport (IV, medications, immobilization, oxygen, etc.), and destination facility
   - visit_date: the date of the incident/transport

E) C-4 FORMS (Workers' Compensation Board Doctor's Report / WCB Form C-4):
    STRICT IDENTIFICATION: Only treat as a C-4 if the document EXPLICITLY shows the official WCB Form C-4 header, title block, or reference number (e.g., "Form C-4", "Workers' Compensation Board", "WCB Report"). Do NOT label regular office visits or injury reports as C-4 unless the actual form is present.

    For ACTUAL C-4 forms only:
    - rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only — ICD codes if present, otherwise the written diagnosis
    - visit_date: the date the form was completed or the examination date — this is CRITICAL to extract even if the rest of the form is illegible
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - CROSS-REFERENCE: If the C-4 date matches an office visit in the same document set, use that visit's rendering provider and/or diagnosis to fill in any illegible C-4 fields. Explicitly note when extrapolated (e.g., "Extrapolated from same-date office visit").
    - ORDERING: The C-4 entry must use the same visit_date as the corresponding office visit so it appears together in chronological order. In the visits array, place the C-4 entry BEFORE the regular office visit entry of the same date.

DEDUPLICATION RULE - Physician Progress Reports vs. Office Visits:
If the same date has BOTH a physician progress report AND an office visit from the SAME provider, IGNORE the physician progress report and ONLY include the office visit. The office visit record contains the actual clinical information, while the progress report is typically a summary/administrative document.

CRITICAL: If the document(s) contain MULTIPLE office visits or patient encounters, you MUST extract each visit separately as individual entries in the visits array.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates mentioned in the documents
- Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES - treat each as a separate visit
- Match ALL findings, exams, and imaging to the CORRECT visit date they were documented on
- NEVER include information from a future visit in an earlier visit
- NEVER reference events (like accidents or injuries) that haven't occurred yet chronologically
- If a location appears multiple times with different dates, create separate visit entries for each date
- Double-check that all information in a visit entry actually occurred on or before that visit date

For EACH entry found across ALL documents, extract the following information:

IMPORTANT: Summarize and condense information - do NOT simply transcribe. Extract only the most relevant and pertinent information.

1. Visit date (if mentioned) - BE PRECISE, this is critical for timeline accuracy
2. Rendering provider name - extract the doctor's name only, not the patient name
3. Practice/setting - for expert reports use "Medical Expert Report", "Independent Medical Examination", or "Chart Review" as appropriate
4. Chief complaint - brief statement of visit purpose or report purpose

5. History of Present Illness (HPI) - SUMMARIZE CONCISELY:
   - Key presenting symptoms and their onset
   - Injury date if applicable (only on first visit) - VERIFY this injury date is BEFORE or ON the visit date
   - Pain scale where provided (e.g., "7/10")
   - Mechanism of injury (brief)
   - Whether symptoms are improved, the same, or worse from prior examinations
   - Relevant past medical history only if directly related
   - For expert reports: summarize the expert's review of the history
   - Keep this section focused and concise, 3-5 sentences maximum
   - DO NOT mention future events or injuries

6. Physical Examination Findings - SUMMARIZE KEY PERTINENT POSITIVES ONLY:
   - ONLY include findings documented on THIS specific visit/report date
   - Pain (location, severity) - only mention if significant
   - Loss of motion/range of motion limitations with specific measurements
   - Deformity, scar formation - only if present
   - Neurological findings (numbness, tingling, burning) - only if present
   - Swelling, tenderness - only if notable
   - Do NOT list normal findings
   - Keep concise, bullet-point style, 3-5 key findings maximum
   - For expert reports with no physical exam: leave empty

7. Imaging findings (X-ray, MRI, CT scans) - include EXACTLY as written, do NOT summarize these, ONLY if performed or reviewed on THIS visit/report date
8. Lab findings (bloodwork panels) - ONLY include if labs were actually performed on THIS visit date, otherwise return empty string
9. Impression/diagnosis - for expert reports include expert opinions, causation analysis, and conclusions with ICD-10 codes if provided (do NOT add codes if not in source)

10. Treatment Plan / Recommendations - SUMMARIZE CONCISELY:
   - Main interventions (medications, therapy, procedures) for clinical visits
   - For expert reports: expert's recommendations, causation opinions, prognosis
   - Activity restrictions if any
   - Follow-up timeline
   - Keep to 2-4 key points, omit routine instructions

Be thorough but CONCISE. Focus on clinically significant information only.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).

Return ALL entries found across ALL documents as separate entries in the visits array.

Also extract:
- Patient name (should be consistent across documents)
- Case number (should be consistent across documents)`;

    return base44.integrations.Core.InvokeLLM({
      prompt,
      ...(fileUrls.length > 0 ? { file_urls: fileUrls } : {}),
      response_json_schema: {
        type: "object",
        properties: {
          patient_name: { type: "string" },
          case_number: { type: "string" },
          visits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                visit_date: { type: "string" },
                rendering_provider: { type: "string" },
                practice_setting: { type: "string" },
                chief_complaint: { type: "string" },
                hpi_summary: { type: "string" },
                injury_date: { type: "string" },
                pain_scale: { type: "string" },
                symptom_progression: { type: "string", enum: ["improved", "same", "worse", "not_documented"] },
                physical_exam_findings: { type: "string" },
                imaging_findings: { type: "string" },
                lab_findings: { type: "string" },
                impression_diagnosis: { type: "string" },
                icd10_codes: { type: "array", items: { type: "string" } },
                treatment_plan: { type: "string" }
              }
            }
          }
        }
      }
    });
  };

  const sanitizeVisits = (visits, patientName) => {
    const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
    const validProgressions = ['improved','same','worse','not_documented'];
    return (visits || []).map(visit => {
      const clean = { ...visit };
      stringFields.forEach(field => {
        const val = clean[field];
        if (val === null || val === undefined || val === false) clean[field] = '';
        else if (typeof val === 'object') clean[field] = JSON.stringify(val);
        else if (typeof val !== 'string') clean[field] = String(val);
      });
      if (!Array.isArray(clean.icd10_codes)) clean.icd10_codes = [];
      if (!validProgressions.includes(clean.symptom_progression)) clean.symptom_progression = 'not_documented';
      const patientLower = patientName?.toLowerCase();
      if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
        clean.practice_setting = '';
      }
      return clean;
    });
  };

  const generateSummary = async () => {
    const selectedDocs = documents
      .filter(d => selectedDocuments.includes(d.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (selectedDocs.length === 0) {
      setError("Please select at least one document to generate a summary.");
      return;
    }

    // Close dialog immediately and run generation in the background
    setShowDialog(false);
    setSelectedDocuments([]);
    setError(null);

    if (generateMode === 'one-by-one') {
      runGenerationPerDoc({ selectedDocs, runAiBatch, sanitizeVisits, deduplicateVisits });
    } else {
      runGeneration({ selectedDocs, runAiBatch, sanitizeVisits, deduplicateVisits });
    }
  };

  const combineSummaries = async () => {
    if (selectedSummariesToCombine.length < 2) return;
    const selected = summaries.filter(s => selectedSummariesToCombine.includes(s.id));
    // Merge all visits from all selected summaries
    let allVisits = selected.flatMap(s => s.visits || []);
    // Sort chronologically
    allVisits.sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      return new Date(a.visit_date) - new Date(b.visit_date);
    });
    // Deduplicate using the same logic as deduplicateVisits (exact match: date + provider + setting)
    const exactKeys = new Set();
    allVisits = allVisits.filter((visit, idx) => {
      const dateKey = (visit.visit_date || '').trim().toLowerCase();
      const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
      const settingKey = (visit.practice_setting || '').trim().toLowerCase();
      if (!dateKey && !providerKey) return true; // no identifying info, keep
      const key = `${dateKey}|${providerKey}|${settingKey}`;
      if (exactKeys.has(key)) return false;
      exactKeys.add(key);
      return true;
    });
    const base = selected[0];
    const combinedData = {
      document_id: [...new Set(selected.flatMap(s => (s.document_id || '').split(',').filter(Boolean)))].join(','),
      patient_name: base.patient_name || '',
      case_number: base.case_number || '',
      visits: allVisits,
      status: 'draft',
      notes: `Combined from ${selected.length} summaries: ${selected.map(s => s.patient_name || s.id).join(', ')}`,
    };
    const newSummary = await base44.entities.MedicalSummary.create(combinedData);
    await queryClient.invalidateQueries({ queryKey: ['summaries'] });
    await queryClient.refetchQueries({ queryKey: ['summaries'] });
    setSelectedSummariesToCombine([]);
    setShowCombineDialog(false);
    setEditing(true);
    setEditingSummary(newSummary);
  };

  const exportToWord = async (summary) => {
    // Get user's font preferences
    const user = await base44.auth.me();
    const fontFamily = user?.export_font_family || 'Calibri';
    const fontSize = user?.export_font_size || 11;
    
    // Check if user has a letterhead and ask whether to use it
    let useLetterhead = false;
    const letterheadUrl = user?.letterhead_url;
    if (letterheadUrl) {
      useLetterhead = window.confirm('Would you like to apply your letterhead as a background watermark on this export?');
    }
    // Sort visits chronologically; C-4 entries come before same-date visits
    const sortedVisits = summary.visits ? [...summary.visits].sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      const dateA = new Date(a.visit_date);
      const dateB = new Date(b.visit_date);
      if (dateA - dateB !== 0) return dateA - dateB;
      const aIsC4 = (a.practice_setting || '').toLowerCase().includes('c-4');
      const bIsC4 = (b.practice_setting || '').toLowerCase().includes('c-4');
      if (aIsC4 && !bIsC4) return -1;
      if (!aIsC4 && bIsC4) return 1;
      return 0;
    }) : [];

    // Generate narrative Word document with diagnosis and treatment plan as separate paragraphs
    const letterheadStyle = useLetterhead && letterheadUrl
      ? `body::before { content: ''; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-image: url('${letterheadUrl}'); background-size: 100% 100%; background-repeat: no-repeat; opacity: 0.15; z-index: -1; }`
      : '';

    // If the summary was saved in free-text/dictation mode, export the plain text version
    if (summary.summary_content) {
      const preText = summary.summary_content
        .split('\n')
        .map(line => `<p style="margin: 0 0 4pt 0;">${line.replace(/^\t/, '&nbsp;&nbsp;&nbsp;&nbsp;') || '&nbsp;'}</p>`)
        .join('');
      const htmlContent = `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Medical Record Summary</title><style>${letterheadStyle}</style></head>
<body style="font-family: ${fontFamily}, Arial, sans-serif; font-size: ${fontSize}pt; line-height: 1.6; margin: 0.5in;">
<h1 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 24pt; text-decoration: underline;">MEDICAL RECORD SUMMARY</h1>
${preText}
<p style="font-size: 10pt; text-align: center; margin-top: 24pt;">Generated by ChartReview Pro on ${new Date().toLocaleDateString()}</p>
</body></html>`;
      const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Medical_Summary_${summary.patient_name || 'Document'}_${new Date().toISOString().split('T')[0]}.doc`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    // Build header section(s) — new IME/Chart Review fields take priority over legacy header_note
    const sectionHeaderTag = (title) =>
      `<p style="font-size: 16pt; font-weight: bold; text-align: center; text-decoration: underline; margin: 24pt 0 12pt 0;">${title}</p>`;

    let headerNoteHtml = '';
    if (summary.ime_note) {
      headerNoteHtml += `${sectionHeaderTag('INDEPENDENT MEDICAL EXAMINATION')}<p style="margin: 0 0 12pt 0; white-space: pre-wrap;">${summary.ime_note.replace(/\n/g, '<br/>')}</p>`;
    }
    if (summary.chart_review_note) {
      headerNoteHtml += `${sectionHeaderTag('CHART REVIEW')}<p style="margin: 0 0 12pt 0; white-space: pre-wrap;">${summary.chart_review_note.replace(/\n/g, '<br/>')}</p>`;
    }
    // Legacy fallback
    if (!summary.ime_note && !summary.chart_review_note && summary.header_note) {
      headerNoteHtml = `<p style="margin: 0 0 18pt 0; white-space: pre-wrap;">${summary.header_note.replace(/\n/g, '<br/>')}</p>`;
    }
    if (headerNoteHtml) headerNoteHtml += '<p>&nbsp;</p>';

    // Document list between header and visits
    let documentListHtml = '';
    if (summary.include_document_list && summary.document_id) {
      const docIds = summary.document_id.split(',').map(s => s.trim()).filter(Boolean);
      if (docIds.length > 0) {
        const allDocs = await base44.entities.Document.list();
        const linkedDocs = allDocs.filter(d => docIds.includes(d.id));
        if (linkedDocs.length > 0) {
          documentListHtml = `<ol style="margin: 0 0 18pt 0; padding-left: 24px; font-family: ${fontFamily}, Arial, sans-serif; font-size: ${fontSize}pt;">`;
          linkedDocs.forEach(doc => {
            documentListHtml += `<li style="margin-bottom: 4pt;">${doc.title}</li>`;
          });
          documentListHtml += '</ol><p>&nbsp;</p>';
        }
      }
    }

    const physicalExamHtml = summary.physical_examination_note
      ? `<p>&nbsp;</p>${sectionHeaderTag('PHYSICAL EXAMINATION')}<p style="margin: 0; white-space: pre-wrap;">${summary.physical_examination_note.replace(/\n/g, '<br/>')}</p>`
      : '';
    const discussionHtml = summary.discussion_note
      ? `<p>&nbsp;</p>${sectionHeaderTag('DISCUSSION')}<p style="margin: 0; white-space: pre-wrap;">${summary.discussion_note.replace(/\n/g, '<br/>')}</p>`
      : '';
    // Legacy footer_note support
    const footerNoteHtml = (!summary.physical_examination_note && !summary.discussion_note && summary.footer_note)
      ? `<p>&nbsp;</p><p style="margin: 18pt 0 0 0; white-space: pre-wrap;">${summary.footer_note.replace(/\n/g, '<br/>')}</p>`
      : '';

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset='utf-8'>
  <title>Medical Record Summary</title>
  <style>
    p.visit {
      margin-bottom: 18pt;
      margin-top: 18pt;
      text-align: left;
    }
    ${letterheadStyle}
  </style>
</head>
<body style="font-family: ${fontFamily}, Arial, sans-serif; font-size: ${fontSize}pt; line-height: 1.6; margin: 0.1in;">

${(!summary.ime_note && !summary.chart_review_note) ? '<h1 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 24pt; text-decoration: underline;">MEDICAL RECORD SUMMARY</h1>' : ''}

<p><strong>Patient:</strong> ${summary.patient_name || 'N/A'}</p>
<p><strong>Case Number:</strong> ${summary.case_number || 'N/A'}</p>

<p>&nbsp;</p>
${headerNoteHtml}
${documentListHtml}

${sortedVisits.map((visit) => {
  let visitHTML = '';

  // Pre-note for this visit
  if (visit.pre_note && visit.pre_note.trim()) {
    visitHTML += `<p style="margin: 18pt 0 6pt 0; font-family: ${fontFamily}, Arial, sans-serif; font-size: ${fontSize}pt; white-space: pre-wrap;">${visit.pre_note.replace(/\n/g, '<br/>')}</p>`;
  }

  // Main content table (excluding diagnosis and treatment plan)
  visitHTML += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 0; margin-top: 18pt; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;"><tr>';

  // Date cell - fixed width
  visitHTML += '<td valign="top" style="width: 120px; padding-right: 0; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;">';
  if (visit.visit_date) {
    const date = new Date(visit.visit_date);
    const formattedDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    visitHTML += `<strong>${formattedDate}:</strong>`;
  }
  visitHTML += '</td>';

  // Content cell - flexible width, left-aligned
  visitHTML += '<td valign="top" style="text-align: left; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;">';

  // Practice setting
  if (visit.practice_setting) {
    visitHTML += `${visit.practice_setting}. `;
  }

  // Rendering provider
  if (visit.rendering_provider) {
    visitHTML += `${visit.rendering_provider}. `;
  }

  // HPI
  if (visit.hpi_summary) {
    visitHTML += `<strong>HPI:</strong> ${visit.hpi_summary} `;

    if (visit.injury_date) {
      visitHTML += `Injury Date: ${new Date(visit.injury_date).toLocaleDateString()}. `;
    }
    if (visit.pain_scale && visit.pain_scale !== 'not_documented') {
      visitHTML += `Pain Scale: ${visit.pain_scale}. `;
    }
    if (visit.symptom_progression && visit.symptom_progression !== 'not_documented') {
      visitHTML += `Symptom Progression: ${visit.symptom_progression.charAt(0).toUpperCase() + visit.symptom_progression.slice(1)}. `;
    }
  }

  // Physical Examination
  if (visit.physical_exam_findings) {
    visitHTML += `<strong>Physical Examination:</strong> ${visit.physical_exam_findings} `;
  }

  // Imaging Findings
  if (visit.imaging_findings) {
    visitHTML += `<strong>Imaging Findings:</strong> ${visit.imaging_findings} `;
  }

  // Lab Findings
  if (visit.lab_findings && visit.lab_findings.trim().length > 0) {
    visitHTML += `<strong>Laboratory Findings:</strong> ${visit.lab_findings}`;
  }

  visitHTML += '</td></tr></table>';

  // Diagnosis as separate paragraph with same alignment
  if (visit.impression_diagnosis) {
    visitHTML += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 0; margin-top: 6pt; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;"><tr>';
    visitHTML += '<td style="width: 120px; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;"></td>';
    visitHTML += '<td valign="top" style="text-align: left; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;">';
    visitHTML += '<strong>Diagnosis:</strong> ';

    // Check if multiple diagnoses
    const diagnosisText = visit.impression_diagnosis.trim();
    const hasMultipleDiagnoses = diagnosisText.match(/^\d+[\.\)]/m) || diagnosisText.includes('\n');

    if (hasMultipleDiagnoses) {
      const diagnoses = diagnosisText.split(/(?:\r?\n)+|\d+[\.\)]\s*/).filter(d => d.trim());
      visitHTML += '<ol style="margin: 0; padding-left: 20px;">';
      diagnoses.forEach(diagnosis => {
        if (diagnosis.trim()) {
          visitHTML += `<li style="margin-bottom: 3pt;">${diagnosis.trim()}</li>`;
        }
      });
      visitHTML += '</ol>';
    } else {
      visitHTML += diagnosisText;
    }

    // Add ICD-10 codes
    if (visit.icd10_codes && visit.icd10_codes.length > 0) {
      visitHTML += ` (ICD-10: ${visit.icd10_codes.join(', ')})`;
    }

    visitHTML += '</td></tr></table>';
  }

  // Treatment Plan as separate paragraph with same alignment
  if (visit.treatment_plan) {
    visitHTML += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 18pt; margin-top: 6pt; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;"><tr>';
    visitHTML += '<td style="width: 120px; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;"></td>';
    visitHTML += '<td valign="top" style="text-align: left; font-family: ' + fontFamily + ', Arial, sans-serif; font-size: ' + fontSize + 'pt;">';
    visitHTML += `<strong>Treatment Plan:</strong> ${visit.treatment_plan}`;
    visitHTML += '</td></tr></table>';
  }

  return visitHTML;
}).join('') || ''}

${physicalExamHtml}
${discussionHtml}
${footerNoteHtml}

<p>&nbsp;</p>
<p style="font-size: 10pt; text-align: center; margin-top: 24pt;">Generated by ChartReview Pro on ${new Date().toLocaleDateString()}</p>

</body>
</html>`.trim();

    // Create blob with Word MIME type and download
    const blob = new Blob(['\ufeff', htmlContent], {
      type: 'application/msword'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Medical_Summary_${summary.patient_name || 'Document'}_${new Date().toISOString().split('T')[0]}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Medical Summaries</h1>
          <p className="text-slate-600 mt-1">Generate structured summaries from any documents</p>
        </div>

        <div className="flex gap-2">
          {summaries.length >= 2 && (
            <Button
              variant="outline"
              onClick={() => { setSelectedSummariesToCombine([]); setShowCombineDialog(true); }}
            >
              <Merge className="w-4 h-4 mr-2" />
              Combine Summaries
            </Button>
          )}
          {summaries.length > 0 && (
            <Button
              variant="destructive"
              onClick={() => setDeleteAllDialog(true)}
              className="bg-red-600 hover:bg-red-700"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All
            </Button>
          )}
          <Button
            onClick={() => {
              setSelectedDocuments([]);
              setError(null);
              setShowDialog(true);
            }}
            className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Generate Summary
          </Button>
        </div>
      </div>

      {error && !showDialog && ( // Display outside dialog if dialog is closed
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Generate Summary Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Select Documents</DialogTitle>
            <DialogDescription>
              Select documents from any folder(s) to generate a comprehensive medical summary. Multiple documents will be combined into a single summary with all visits.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {selectedDocuments.length > 0 && (
              <Alert className="bg-blue-50 border-blue-200">
                <Users className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800">
                  {selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''} selected from {[...new Set(documents.filter(d => selectedDocuments.includes(d.id)).map(d => d.folder || 'Unfiled'))].length} folder{[...new Set(documents.filter(d => selectedDocuments.includes(d.id)).map(d => d.folder || 'Unfiled'))].length !== 1 ? 's' : ''}.
                  {selectedDocuments.length > 1 && ' All visits will be combined into one summary.'}
                </AlertDescription>
              </Alert>
            )}

            {/* Documents grouped by folder */}
            <div className="space-y-6">
              {Object.keys(documentsByFolder).sort().map(folderName => {
                const folderDocs = documentsByFolder[folderName];
                const folderSelected = folderDocs.filter(d => selectedDocuments.includes(d.id)).length;
                
                // Group folder docs by facility/provider
                const normalizeProviderName = (name) => {
                  return (name || '')
                    .trim()
                    .toLowerCase()
                    .replace(/\s+and\s+rehabilitation\b/gi, '')
                    .replace(/\s+rehabilitation\b/gi, '')
                    .replace(/\s+center\b/gi, '')
                    .replace(/\s+clinic\b/gi, '')
                    .replace(/\s+medical\s+group\b/gi, '')
                    .replace(/\s+associates\b/gi, '')
                    .replace(/\s+hospital\b/gi, '')
                    .replace(/\s+health\s*care\b/gi, '')
                    .replace(/[^a-z0-9]/g, '') // strip all non-alphanumeric for fuzzy match
                    .trim();
                };

                // Extract part number from filename — supports part1, part_1, _1, -1, (1) at end of stem
                const getPartNumber = (title) => {
                  const stem = title.replace(/\.[^.]+$/, ''); // remove extension
                  const patterns = [
                    /part[_\-\s]*(\d+)/i,
                    /[_\-\s](\d+)$/,
                    /\((\d+)\)$/,
                    /(\d+)$/
                  ];
                  for (const p of patterns) {
                    const m = stem.match(p);
                    if (m) return parseInt(m[1], 10);
                  }
                  return null;
                };

                const folderGroups = folderDocs.reduce((groups, doc) => {
                  const providerName = doc.provider_name || 'Unknown Facility';
                  const normalizedKey = normalizeProviderName(providerName) || 'unknown';
                  if (!groups[normalizedKey]) {
                    groups[normalizedKey] = { displayName: providerName, docs: [] };
                  }
                  groups[normalizedKey].docs.push(doc);
                  return groups;
                }, {});

                // Sort docs within each group numerically by part number, then alphabetically
                Object.keys(folderGroups).forEach(key => {
                  folderGroups[key].docs.sort((a, b) => {
                    const numA = getPartNumber(a.title);
                    const numB = getPartNumber(b.title);
                    if (numA !== null && numB !== null) return numA - numB;
                    if (numA !== null) return -1;
                    if (numB !== null) return 1;
                    return a.title.localeCompare(b.title);
                  });
                });

                const allFolderSelected = folderDocs.every(d => selectedDocuments.includes(d.id));

                const selectAllFolder = () => {
                  const folderIds = folderDocs.map(d => d.id);
                  if (allFolderSelected) {
                    setSelectedDocuments(prev => prev.filter(id => !folderIds.includes(id)));
                  } else {
                    setSelectedDocuments(prev => [...new Set([...prev, ...folderIds])]);
                  }
                };

                return (
                  <div key={folderName} className="border-2 border-slate-200 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <div className="flex items-center gap-3">
                        <Folder className="w-5 h-5 text-blue-600" />
                        <h3 className="font-semibold text-slate-900">{folderName}</h3>
                        {folderSelected > 0 && (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700">
                            {folderSelected} selected
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={selectAllFolder}
                        className={allFolderSelected ? 'bg-blue-50 border-blue-300 text-blue-700' : 'text-slate-600'}
                      >
                        {allFolderSelected ? <CheckSquare className="w-4 h-4 mr-1" /> : <Square className="w-4 h-4 mr-1" />}
                        {allFolderSelected ? 'Deselect All' : 'Select All'}
                      </Button>
                    </div>

                    <div className="space-y-3">
                      {Object.entries(folderGroups).sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, groupData]) => {
                        const facilityName = groupData.displayName;
                        const groupDocs = groupData.docs;
                        const allSelected = groupDocs.every(d => selectedDocuments.includes(d.id));

                        return (
                          <Card key={groupKey} className="border">
                            <CardHeader className="bg-slate-50 pb-3 pt-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => selectGroup(groupDocs)}
                                    className={allSelected ? 'bg-blue-50 border-blue-300' : ''}
                                  >
                                    {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                                  </Button>
                                  <div>
                                    <h4 className="font-medium text-sm text-slate-900">{facilityName}</h4>
                                  </div>
                                </div>
                                <Badge variant="outline" className="text-xs">
                                  {groupDocs.length} doc{groupDocs.length !== 1 ? 's' : ''}
                                </Badge>
                              </div>
                            </CardHeader>
                            <CardContent className="pt-3 space-y-2">
                              {groupDocs.map(doc => (
                                <div
                                  key={doc.id}
                                  className={`flex items-start gap-3 p-2 rounded-lg border transition-all cursor-pointer ${
                                    selectedDocuments.includes(doc.id)
                                      ? 'bg-blue-50 border-blue-300'
                                      : 'bg-white border-slate-200 hover:border-slate-300'
                                  }`}
                                  onClick={() => toggleDocumentSelection(doc.id)}
                                >
                                  <Checkbox
                                   checked={selectedDocuments.includes(doc.id)}
                                   onCheckedChange={() => toggleDocumentSelection(doc.id)}
                                   onClick={e => e.stopPropagation()}
                                   className="mt-0.5"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-900 truncate">{doc.title}</p>
                                    <div className="flex flex-wrap gap-2 mt-1 text-xs text-slate-500">
                                      {doc.category && (
                                        <Badge variant="outline" className={
                                          doc.category === 'medical'
                                            ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                                            : doc.category === 'legal'
                                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                                            : 'bg-slate-50 text-slate-700 border-slate-200'
                                        }>
                                          {doc.category}
                                        </Badge>
                                      )}
                                      {doc.document_date && (
                                        <span>• {new Date(doc.document_date).toLocaleDateString()}</span>
                                      )}
                                      {doc.file_size && (
                                        <span>• {(doc.file_size / (1024 * 1024)).toFixed(2)} MB</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {documents.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <FileCheck className="w-16 h-16 mx-auto mb-4 text-slate-300" />
                  <p>No documents found</p>
                  <p className="text-sm mt-2">Upload documents first to generate summaries</p>
                </div>
              )}
            </div>

            {/* Generation mode selector */}
            {selectedDocuments.length > 1 && (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Generation Mode</p>
                <div className="flex flex-col gap-2">
                  <label className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${generateMode === 'batch' ? 'bg-white border-blue-300 shadow-sm' : 'border-transparent hover:border-slate-300'}`}>
                    <input type="radio" className="mt-0.5" checked={generateMode === 'batch'} onChange={() => setGenerateMode('batch')} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">Batch (default)</p>
                      <p className="text-xs text-slate-500">Analyzes all documents together — faster, but may timeout on large files.</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${generateMode === 'one-by-one' ? 'bg-white border-blue-300 shadow-sm' : 'border-transparent hover:border-slate-300'}`}>
                    <input type="radio" className="mt-0.5" checked={generateMode === 'one-by-one'} onChange={() => setGenerateMode('one-by-one')} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">One-by-one then combine</p>
                      <p className="text-xs text-slate-500">Generates each document separately, then merges into one summary. Best for large documents.</p>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {queueProgress && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">Processing batch {queueProgress.current} of {queueProgress.total}...</span>
                  <span className="text-xs">{Math.round((queueProgress.current / queueProgress.total) * 100)}%</span>
                </div>
                <div className="w-full bg-blue-200 rounded-full h-1.5">
                  <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${(queueProgress.current / queueProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
            <Button
              onClick={generateSummary}
              disabled={selectedDocuments.length === 0 || generatingSummary}
              className="w-full bg-gradient-to-r from-blue-600 to-cyan-600"
            >
              {generatingSummary ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {queueProgress ? `Batch ${queueProgress.current}/${queueProgress.total}...` : 'Analyzing...'}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate Summary from {selectedDocuments.length || 0} Document{selectedDocuments.length !== 1 ? 's' : ''}

                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Summaries Grid */}
      {summariesLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-32 bg-slate-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : summaries.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {summaries.map((summary) => (
            <Card key={summary.id} className="hover:shadow-lg transition-all duration-300 group">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-100 to-emerald-100 flex items-center justify-center">
                      <FileCheck className="w-6 h-6 text-green-600" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          summary.status === 'finalized'
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : summary.status === 'reviewed'
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }
                      >
                        {summary.status}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => setDeleteSummary(summary)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-slate-900 mb-2">
                      {summary.patient_name || 'Unnamed Patient'}
                    </h3>
                    {summary.case_number && (
                      <p className="text-sm text-slate-600">Case: {summary.case_number}</p>
                    )}
                    <p className="text-sm text-slate-600">
                      {summary.visits?.length || 0} visit{summary.visits?.length !== 1 ? 's' : ''}
                    </p>
                    {summary.document_id?.includes(',') && (
                      <Badge variant="outline" className="mt-2 bg-purple-50 text-purple-700 border-purple-200">
                        <Users className="w-3 h-3 mr-1" />
                        Combined
                      </Badge>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setViewingSummary(summary)}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => { setEditing(true); setEditingSummary(summary); }}
                    >
                      <Edit className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportToWord(summary)}
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      title="Remove duplicate visits"
                      onClick={() => deduplicateMutation.mutate(summary)}
                      disabled={deduplicateMutation.isPending}
                    >
                      <Filter className="w-4 h-4" />
                    </Button>
                  </div>

                  <div className="pt-3 border-t border-slate-200 text-xs text-slate-500">
                    Created {new Date(summary.created_date).toLocaleDateString()}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="shadow-md">
          <CardContent className="p-12 text-center">
            <FileCheck className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-900 text-lg font-semibold">No summaries yet</p>
            <p className="text-slate-500 text-sm mt-2">
              Generate your first medical summary from one or more documents
            </p>
          </CardContent>
        </Card>
      )}

      {/* View Summary Dialog */}
      {viewingSummary && (
        <SummaryViewer
          summary={viewingSummary}
          onClose={() => setViewingSummary(null)}
          onEdit={() => {
            setEditing(true);
            setEditingSummary(viewingSummary);
            setViewingSummary(null);
          }}
          onExport={() => exportToWord(viewingSummary)}
        />
      )}

      {/* Edit Summary Dialog */}
      {editingSummary && (
        <MedicalSummaryForm
          summary={editingSummary}
          onClose={() => { setEditing(false); setEditingSummary(null); }}
          onSave={() => { setEditing(false); queryClient.invalidateQueries({ queryKey: ['summaries'] }); setEditingSummary(null); }}
        />
      )}

      {/* Combine Summaries Dialog */}
      <Dialog open={showCombineDialog} onOpenChange={setShowCombineDialog}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Combine Summaries</DialogTitle>
            <DialogDescription>
              Select 2 or more summaries to merge their visits into a single combined summary.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {summaries.map(s => {
              const isSelected = selectedSummariesToCombine.includes(s.id);
              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${isSelected ? 'bg-blue-50 border-blue-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}
                  onClick={() => setSelectedSummariesToCombine(prev =>
                    prev.includes(s.id) ? prev.filter(id => id !== s.id) : [...prev, s.id]
                  )}
                >
                  <Checkbox checked={isSelected} onCheckedChange={() => {}} className="pointer-events-none" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-900">{s.patient_name || 'Unnamed Patient'}</p>
                    <p className="text-xs text-slate-500">
                      {s.visits?.length || 0} visits • Created {new Date(s.created_date).toLocaleDateString()}
                      {s.case_number && ` • Case: ${s.case_number}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => setShowCombineDialog(false)}>Cancel</Button>
            <Button
              disabled={selectedSummariesToCombine.length < 2}
              onClick={combineSummaries}
              className="bg-gradient-to-r from-purple-600 to-indigo-600"
            >
              <Merge className="w-4 h-4 mr-2" />
              Combine {selectedSummariesToCombine.length} Summaries
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete All Confirmation Dialog */}
      <AlertDialog open={deleteAllDialog} onOpenChange={setDeleteAllDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Summaries</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete all {summaries.length} medical summaries? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAllMutation.mutate()}
              disabled={deleteAllMutation.isLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteAllMutation.isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting...</> : `Delete All ${summaries.length} Summaries`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteSummary} onOpenChange={() => setDeleteSummary(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Medical Summary</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this medical summary for {deleteSummary?.patient_name || 'this patient'}?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(deleteSummary.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete Summary
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}