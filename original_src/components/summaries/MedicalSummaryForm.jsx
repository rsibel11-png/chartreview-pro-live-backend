import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, X, Plus, Trash2, Mic } from "lucide-react";
import MacroPicker from "./MacroPicker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import DuplicateVisitDetector from "./DuplicateVisitDetector";
import PTConsolidationHelper from "./PTConsolidationHelper";

const STRING_VISIT_FIELDS = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
const VALID_PROGRESSIONS = ['improved','same','worse','not_documented'];

function sanitizeSummary(s) {
  return {
    ...s,
    visits: (s.visits || []).map(visit => {
      const clean = { ...visit };
      STRING_VISIT_FIELDS.forEach(field => {
        const val = clean[field];
        if (val === null || val === undefined || val === false) clean[field] = '';
        else if (typeof val === 'object') clean[field] = JSON.stringify(val);
        else if (typeof val !== 'string') clean[field] = String(val);
      });
      if (!Array.isArray(clean.icd10_codes)) clean.icd10_codes = [];
      if (!VALID_PROGRESSIONS.includes(clean.symptom_progression)) clean.symptom_progression = 'not_documented';
      return clean;
    })
  };
}

// Build a plain-text narrative of the summary for free editing
function buildNarrative(formData) {
  const sortedVisits = [...(formData.visits || [])].sort((a, b) => {
    if (!a.visit_date) return 1;
    if (!b.visit_date) return -1;
    return new Date(a.visit_date) - new Date(b.visit_date);
  });
  const lines = [];
  lines.push(`Patient: ${formData.patient_name || ''}`);
  lines.push(`Case Number: ${formData.case_number || ''}`);
  lines.push('');
  sortedVisits.forEach((visit) => {
    const date = visit.visit_date ? new Date(visit.visit_date + 'T00:00:00').toLocaleDateString() : '';
    let line = date ? `${date}: ` : '';
    if (visit.practice_setting) line += `${visit.practice_setting}. `;
    if (visit.rendering_provider) line += `${visit.rendering_provider}. `;
    if (visit.hpi_summary) {
      line += `HPI: ${visit.hpi_summary} `;
      if (visit.injury_date) line += `Injury Date: ${new Date(visit.injury_date + 'T00:00:00').toLocaleDateString()}. `;
      if (visit.pain_scale) line += `Pain Scale: ${visit.pain_scale}. `;
      if (visit.symptom_progression && visit.symptom_progression !== 'not_documented')
        line += `Symptom Progression: ${visit.symptom_progression.charAt(0).toUpperCase() + visit.symptom_progression.slice(1)}. `;
    }
    if (visit.physical_exam_findings) line += `Physical Examination: ${visit.physical_exam_findings} `;
    if (visit.imaging_findings) line += `Imaging Findings: ${visit.imaging_findings} `;
    if (visit.lab_findings) line += `Laboratory Findings: ${visit.lab_findings} `;
    lines.push(line.trim());
    if (visit.impression_diagnosis) lines.push(`\tDiagnosis: ${visit.impression_diagnosis}`);
    if (visit.treatment_plan) lines.push(`\tTreatment Plan: ${visit.treatment_plan}`);
    lines.push('');
  });
  return lines.join('\n');
}

export default function MedicalSummaryForm({ summary, onClose, onSave }) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState(() => sanitizeSummary(summary));
  const [expandedVisit, setExpandedVisit] = useState(0);
  const [providerPracticeMap, setProviderPracticeMap] = useState({});
  const [editMode, setEditMode] = useState('structured'); // 'structured' | 'freetext'
  const [freeText, setFreeText] = useState('');
  const [icd10Input, setIcd10Input] = useState({});
  const freeTextRef = useRef(null);

  // Fetch documents linked to this summary
  const linkedDocIds = (summary.document_id || '').split(',').map(s => s.trim()).filter(Boolean);
  const { data: allDocuments = [] } = useQuery({
    queryKey: ['documents-for-summary'],
    queryFn: () => base44.entities.Document.list(),
    initialData: [],
  });
  const linkedDocuments = allDocuments.filter(d => linkedDocIds.includes(d.id));

  // Fetch all summaries to build provider-practice setting associations
  const { data: allSummaries = [] } = useQuery({
    queryKey: ['all-summaries-for-rules'],
    queryFn: () => base44.entities.MedicalSummary.list(),
    initialData: [],
  });

  // Build provider-practice setting frequency map
  useEffect(() => {
    const frequencyMap = {};
    
    allSummaries.forEach(summary => {
      summary.visits?.forEach(visit => {
        if (visit.rendering_provider && visit.practice_setting) {
          const provider = visit.rendering_provider.trim();
          if (!frequencyMap[provider]) {
            frequencyMap[provider] = {};
          }
          const setting = visit.practice_setting.trim();
          frequencyMap[provider][setting] = (frequencyMap[provider][setting] || 0) + 1;
        }
      });
    });

    // Convert to map of provider -> most frequent practice setting
    const providerMap = {};
    Object.keys(frequencyMap).forEach(provider => {
      const settings = frequencyMap[provider];
      const mostFrequent = Object.keys(settings).reduce((a, b) => 
        settings[a] > settings[b] ? a : b
      );
      providerMap[provider] = mostFrequent;
    });

    setProviderPracticeMap(providerMap);
  }, [allSummaries]);

  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.MedicalSummary.update(summary.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      queryClient.invalidateQueries({ queryKey: ['all-summaries-for-rules'] });
      onSave();
    },
  });

  const switchToFreeText = () => {
    setFreeText(buildNarrative(formData));
    setEditMode('freetext');
    setTimeout(() => freeTextRef.current?.focus(), 100);
  };

  const handleSave = () => {
    if (editMode === 'freetext') {
      // Save the free-text as summary_content so it's preserved and exported
      updateMutation.mutate(sanitizeSummary({ ...formData, summary_content: freeText }));
    } else {
      updateMutation.mutate(sanitizeSummary(formData));
    }
  };

  const updateVisit = (index, field, value) => {
    setFormData(prev => ({
      ...prev,
      visits: prev.visits.map((visit, i) => 
        i === index ? { ...visit, [field]: value } : visit
      )
    }));
  };

  // Auto-populate practice setting when provider changes
  const handleProviderChange = (index, providerName) => {
    updateVisit(index, 'rendering_provider', providerName);
    
    // If this provider has a known practice setting and current practice setting is empty
    const trimmedProvider = providerName.trim();
    if (providerPracticeMap[trimmedProvider] && !formData.visits[index].practice_setting) {
      updateVisit(index, 'practice_setting', providerPracticeMap[trimmedProvider]);
    }
  };

  const addVisit = () => {
    setFormData(prev => ({
      ...prev,
      visits: [...(prev.visits || []), {
        visit_date: '',
        rendering_provider: '',
        practice_setting: '',
        chief_complaint: '',
        hpi_summary: '',
        injury_date: '',
        pain_scale: '',
        symptom_progression: 'not_documented',
        physical_exam_findings: '',
        imaging_findings: '',
        lab_findings: '',
        impression_diagnosis: '',
        icd10_codes: [],
        treatment_plan: ''
      }]
    }));
    setExpandedVisit((prev.visits || []).length);
  };

  const removeVisit = (index) => {
    setFormData(prev => ({
      ...prev,
      visits: prev.visits.filter((_, i) => i !== index)
    }));
    if (expandedVisit >= (formData.visits?.length || 0) - 1) {
      setExpandedVisit(Math.max(0, expandedVisit - 1));
    }
  };

  // Detect if a visit is associated with a C-4 form
  const isC4Visit = (visit) => {
    const fields = [visit.chief_complaint, visit.hpi_summary, visit.practice_setting, visit.rendering_provider, visit.impression_diagnosis, visit.treatment_plan];
    return fields.some(f => f && /c-?4\b/i.test(f));
  };

  const handleDuplicateAction = (action, visitIndices) => {
    if (action === "delete-selected") {
      const indicesToDelete = new Set(visitIndices);
      setFormData(prev => {
        // For each visit being deleted, check if it's a C-4
        // If so, find a surviving visit on the same date and merge C-4 content into it
        const mergeMap = {}; // survivingIndex -> content to append

        prev.visits.forEach((visit, i) => {
          if (!indicesToDelete.has(i)) return;
          if (!isC4Visit(visit)) return;

          // Find a surviving visit on the same date
          const survivingIdx = prev.visits.findIndex((v, j) =>
            !indicesToDelete.has(j) && v.visit_date === visit.visit_date
          );
          if (survivingIdx === -1) return; // no survivor on same day, keep visit

          if (!mergeMap[survivingIdx]) mergeMap[survivingIdx] = [];
          mergeMap[survivingIdx].push(visit);
          // Remove from deletion since we're merging
          // Actually we still delete but we merge content into survivor
        });

        const newVisits = prev.visits
          .map((visit, i) => {
            if (!mergeMap[i]) return visit;
            // Merge C-4 content from deleted visits into this surviving visit
            const c4Visits = mergeMap[i];
            let merged = { ...visit };
            c4Visits.forEach(c4 => {
              const append = (field, separator = '\n') => {
                if (c4[field] && !merged[field]?.includes(c4[field])) {
                  merged[field] = merged[field] ? `${merged[field]}${separator}[C-4] ${c4[field]}` : `[C-4] ${c4[field]}`;
                }
              };
              append('chief_complaint', ' | ');
              append('hpi_summary');
              append('impression_diagnosis');
              append('treatment_plan');
              append('physical_exam_findings');
              // Merge ICD-10 codes
              if (c4.icd10_codes?.length) {
                const existing = new Set(merged.icd10_codes || []);
                c4.icd10_codes.forEach(code => existing.add(code));
                merged.icd10_codes = Array.from(existing);
              }
            });
            return merged;
          })
          .filter((_, i) => !indicesToDelete.has(i));

        return { ...prev, visits: newVisits };
      });
      setExpandedVisit(0);
    }
  };

  const handlePTConsolidate = (consolidatedData, ptVisits) => {
    // Remove all PT visits and replace with two: initial visit and final visit
    const ptVisitIndices = new Set();
    formData.visits.forEach((v, i) => {
      if (ptVisits.includes(v)) {
        ptVisitIndices.add(i);
      }
    });

    const { firstVisit, lastVisit, facility, totalSessions } = consolidatedData;

    const makeBase = (v) => ({
      visit_date: v.visit_date || '',
      rendering_provider: v.rendering_provider || '',
      practice_setting: facility,
      injury_date: '',
      pain_scale: v.pain_scale || '',
      symptom_progression: v.symptom_progression || 'not_documented',
      imaging_findings: v.imaging_findings || '',
      lab_findings: v.lab_findings || '',
      icd10_codes: v.icd10_codes || [],
    });

    const initialVisitEntry = {
      ...makeBase(firstVisit),
      pre_note: 'Initial Visit',
      chief_complaint: firstVisit.chief_complaint || '',
      hpi_summary: firstVisit.hpi_summary || '',
      physical_exam_findings: firstVisit.physical_exam_findings || '',
      impression_diagnosis: firstVisit.impression_diagnosis || '',
      treatment_plan: firstVisit.treatment_plan || '',
    };

    const finalVisitEntry = {
      ...makeBase(lastVisit),
      pre_note: `Final Visit. ${totalSessions} visits attended.`,
      chief_complaint: lastVisit.chief_complaint || '',
      hpi_summary: lastVisit.hpi_summary || '',
      physical_exam_findings: lastVisit.physical_exam_findings || '',
      impression_diagnosis: lastVisit.impression_diagnosis || '',
      treatment_plan: lastVisit.treatment_plan || '',
    };

    setFormData(prev => ({
      ...prev,
      visits: [
        ...prev.visits.filter((_, i) => !ptVisitIndices.has(i)),
        initialVisitEntry,
        finalVisitEntry,
      ]
    }));
  };

  const addIcd10Code = (visitIndex, code) => {
    if (code.trim()) {
      updateVisit(visitIndex, 'icd10_codes', [
        ...(formData.visits[visitIndex].icd10_codes || []),
        code.trim()
      ]);
    }
  };

  const removeIcd10Code = (visitIndex, codeIndex) => {
    updateVisit(visitIndex, 'icd10_codes', 
      formData.visits[visitIndex].icd10_codes.filter((_, i) => i !== codeIndex)
    );
  };

  // Get unique provider names for datalist
  const uniqueProviders = Object.keys(providerPracticeMap).sort();

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-2xl">Edit Medical Summary</DialogTitle>
            <div className="flex items-center gap-2 mr-6">
              <button
                onClick={() => { setEditMode('structured'); }}
                className={`px-3 py-1.5 rounded-l-lg border text-sm font-medium transition-all ${editMode === 'structured' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
              >
                Structured
              </button>
              <button
                onClick={switchToFreeText}
                className={`px-3 py-1.5 rounded-r-lg border-t border-r border-b text-sm font-medium transition-all flex items-center gap-1.5 ${editMode === 'freetext' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
              >
                <Mic className="w-3.5 h-3.5" />
                Free Edit / Dictate
              </button>
            </div>
          </div>
          </DialogHeader>

        <>
        {editMode === 'freetext' ? (
          <div className="py-4 space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <strong>Free Edit / Dictation Mode:</strong> Click inside the box below and use Dragon Medical One or any dictation software to freely edit the summary. All changes will be saved as-is on export.
            </div>
            <textarea
              ref={freeTextRef}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              className="w-full min-h-[500px] p-4 font-mono text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              spellCheck={true}
              style={{ lineHeight: '1.7' }}
            />
            <p className="text-xs text-slate-500">Tip: Position your cursor anywhere in the text and start dictating. Dragon Medical One will type directly into this field.</p>
          </div>
        ) : (

        <div className="space-y-6 py-4">
          {/* PT Consolidation Helper */}
          {formData.visits && formData.visits.length > 0 && (
            <PTConsolidationHelper
              visits={formData.visits}
              onConsolidate={handlePTConsolidate}
            />
          )}

          {/* Duplicate Visit Detection */}
          {formData.visits && formData.visits.length > 0 && (
            <DuplicateVisitDetector
              visits={formData.visits}
              onDuplicateAction={handleDuplicateAction}
            />
          )}

          {/* Patient Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Patient Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="patient_name">Patient Name</Label>
                  <Input
                    id="patient_name"
                    value={formData.patient_name || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, patient_name: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="case_number">Case Number</Label>
                  <Input
                    id="case_number"
                    value={formData.case_number || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, case_number: e.target.value }))}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="status">Summary Status</Label>
                <Select
                  value={formData.status || 'draft'}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                    <SelectItem value="finalized">Finalized</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* IME Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                INDEPENDENT MEDICAL EXAMINATION{' '}
                <span className="text-sm font-normal text-slate-500">(exported as bold centered section header)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Independent medical examination header text..."
                value={formData.ime_note || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, ime_note: e.target.value }))}
                rows={3}
              />
              <MacroPicker
                section="header"
                currentText={formData.ime_note || ''}
                onInsert={(text) => setFormData(prev => ({ ...prev, ime_note: text }))}
              />
            </CardContent>
          </Card>

          {/* Chart Review Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                CHART REVIEW{' '}
                <span className="text-sm font-normal text-slate-500">(exported as bold centered section header)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Chart review header text..."
                value={formData.chart_review_note || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, chart_review_note: e.target.value }))}
                rows={3}
              />
              <MacroPicker
                section="header"
                currentText={formData.chart_review_note || ''}
                onInsert={(text) => setFormData(prev => ({ ...prev, chart_review_note: text }))}
              />
            </CardContent>
          </Card>

          {/* Document List Toggle */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-start gap-4">
                <div className="flex-1">
                  <p className="font-medium text-slate-900">Include Document List</p>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Insert a numbered list of all source documents between the header and the medical summary in the export.
                  </p>
                  {formData.include_document_list && linkedDocuments.length > 0 && (
                    <ol className="mt-3 text-sm text-slate-700 space-y-1 list-decimal list-inside pl-1">
                      {linkedDocuments.map(doc => (
                        <li key={doc.id}>{doc.title}</li>
                      ))}
                    </ol>
                  )}
                  {formData.include_document_list && linkedDocuments.length === 0 && (
                    <p className="mt-2 text-sm text-amber-600">No linked documents found.</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, include_document_list: !prev.include_document_list }))}
                  className={`mt-0.5 w-12 h-6 rounded-full transition-colors flex-shrink-0 relative ${formData.include_document_list ? 'bg-blue-600' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${formData.include_document_list ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* Visits */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900">
                Office Visits ({formData.visits?.length || 0})
              </h3>
              <Button onClick={addVisit} size="sm" variant="outline">
                <Plus className="w-4 h-4 mr-2" />
                Add Visit
              </Button>
            </div>

            {formData.visits?.map((visit, index) => {
               const isExpanded = expandedVisit === index;
              
              return (
                <Card key={index} className="border-2">
                  <CardHeader className="cursor-pointer bg-slate-50" onClick={() => setExpandedVisit(isExpanded ? -1 : index)}>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">
                        Visit {index + 1}
                        {visit.visit_date && ` - ${new Date(visit.visit_date).toLocaleDateString()}`}
                        {visit.rendering_provider && ` - ${visit.rendering_provider}`}
                      </CardTitle>
                      <div className="flex gap-2">
                        {formData.visits.length > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); removeVisit(index); }}
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                        <Badge variant="outline">
                          {isExpanded ? 'Collapse' : 'Expand'}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>

                  {isExpanded && (
                    <CardContent className="pt-6 space-y-4">
                      {/* Pre-note */}
                      <div>
                        <Label>Note Before This Visit <span className="text-xs font-normal text-slate-500">(appears before this visit in export)</span></Label>
                        <Textarea
                          placeholder="Optional free text to insert before this visit..."
                          value={visit.pre_note || ''}
                          onChange={(e) => updateVisit(index, 'pre_note', e.target.value)}
                          rows={2}
                        />
                        <MacroPicker
                          section="pre_note"
                          currentText={visit.pre_note || ''}
                          onInsert={(text) => updateVisit(index, 'pre_note', text)}
                        />
                      </div>

                      {/* Visit Date and Injury Date */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label>Visit Date</Label>
                          <Input
                            type="date"
                            value={visit.visit_date || ''}
                            onChange={(e) => updateVisit(index, 'visit_date', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>Injury Date (if applicable)</Label>
                          <Input
                            type="date"
                            value={visit.injury_date || ''}
                            onChange={(e) => updateVisit(index, 'injury_date', e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Provider and Setting with auto-fill */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label>Rendering Provider</Label>
                          <Input
                            list={`providers-${index}`}
                            value={visit.rendering_provider || ''}
                            onChange={(e) => handleProviderChange(index, e.target.value)}
                            placeholder="Enter provider name"
                          />
                          <datalist id={`providers-${index}`}>
                            {uniqueProviders.map(provider => (
                              <option key={provider} value={provider} />
                            ))}
                          </datalist>
                          {visit.rendering_provider && providerPracticeMap[visit.rendering_provider.trim()] && (
                            <p className="text-xs text-blue-600 mt-1">
                              Suggested: {providerPracticeMap[visit.rendering_provider.trim()]}
                            </p>
                          )}
                        </div>
                        <div>
                          <Label>Practice Setting</Label>
                          <Input
                            value={visit.practice_setting || ''}
                            onChange={(e) => updateVisit(index, 'practice_setting', e.target.value)}
                            placeholder="Auto-filled based on provider"
                          />
                        </div>
                      </div>

                      {/* Chief Complaint */}
                      <div>
                        <Label>Chief Complaint</Label>
                        <Textarea
                          value={visit.chief_complaint || ''}
                          onChange={(e) => updateVisit(index, 'chief_complaint', e.target.value)}
                          rows={2}
                        />
                      </div>

                      {/* HPI */}
                      <div>
                        <Label>History of Present Illness</Label>
                        <Textarea
                          value={visit.hpi_summary || ''}
                          onChange={(e) => updateVisit(index, 'hpi_summary', e.target.value)}
                          rows={4}
                        />
                      </div>

                      {/* HPI Details */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label>Pain Scale</Label>
                          <Input
                            placeholder="e.g., 7/10"
                            value={visit.pain_scale || ''}
                            onChange={(e) => updateVisit(index, 'pain_scale', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>Symptom Progression</Label>
                          <Select
                            value={visit.symptom_progression || 'not_documented'}
                            onValueChange={(value) => updateVisit(index, 'symptom_progression', value)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="improved">Improved</SelectItem>
                              <SelectItem value="same">Same</SelectItem>
                              <SelectItem value="worse">Worse</SelectItem>
                              <SelectItem value="not_documented">Not Documented</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* Physical Exam */}
                      <div>
                        <Label>Physical Examination Findings</Label>
                        <Textarea
                          placeholder="Key pertinent positives only"
                          value={visit.physical_exam_findings || ''}
                          onChange={(e) => updateVisit(index, 'physical_exam_findings', e.target.value)}
                          rows={4}
                        />
                      </div>

                      {/* Imaging */}
                      <div>
                        <Label>Imaging Findings</Label>
                        <Textarea
                          placeholder="Exact text from report"
                          value={visit.imaging_findings || ''}
                          onChange={(e) => updateVisit(index, 'imaging_findings', e.target.value)}
                          rows={3}
                        />
                      </div>

                      {/* Labs */}
                      <div>
                        <Label>Laboratory Findings</Label>
                        <Textarea
                          placeholder="Leave empty if no labs performed"
                          value={visit.lab_findings || ''}
                          onChange={(e) => updateVisit(index, 'lab_findings', e.target.value)}
                          rows={3}
                        />
                      </div>

                      {/* Impression/Diagnosis */}
                      <div>
                        <Label>Impression/Diagnosis</Label>
                        <Textarea
                          value={visit.impression_diagnosis || ''}
                          onChange={(e) => updateVisit(index, 'impression_diagnosis', e.target.value)}
                          rows={3}
                        />
                      </div>

                      {/* ICD-10 Codes */}
                      <div>
                        <Label>ICD-10 Codes</Label>
                        <div className="flex gap-2 mt-2">
                          <Input
                            placeholder="Enter ICD-10 code"
                            value={icd10Input[index] || ''}
                            onChange={(e) => setIcd10Input(prev => ({ ...prev, [index]: e.target.value }))}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addIcd10Code(index, icd10Input[index] || '');
                                setIcd10Input(prev => ({ ...prev, [index]: '' }));
                              }
                            }}
                          />
                          <Button 
                            type="button" 
                            onClick={() => {
                              addIcd10Code(index, icd10Input[index] || '');
                              setIcd10Input(prev => ({ ...prev, [index]: '' }));
                            }} 
                            variant="outline"
                          >
                            Add
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-2 mt-3">
                          {visit.icd10_codes?.map((code, codeIdx) => (
                            <Badge key={codeIdx} variant="secondary">
                              {code}
                              <button
                                onClick={() => removeIcd10Code(index, codeIdx)}
                                className="ml-2 hover:text-red-600"
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                      </div>

                      {/* Treatment Plan */}
                      <div>
                        <Label>Treatment Plan</Label>
                        <Textarea
                          value={visit.treatment_plan || ''}
                          onChange={(e) => updateVisit(index, 'treatment_plan', e.target.value)}
                          rows={3}
                        />
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}

            {(!formData.visits || formData.visits.length === 0) && (
              <Card className="p-12 text-center">
                <p className="text-slate-500 mb-4">No visits added yet</p>
                <Button onClick={addVisit} variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  Add First Visit
                </Button>
              </Card>
            )}
          </div>

          <Separator />

          {/* Physical Examination Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                PHYSICAL EXAMINATION{' '}
                <span className="text-sm font-normal text-slate-500">(exported as bold centered section header)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Physical examination findings to appear in this section..."
                value={formData.physical_examination_note || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, physical_examination_note: e.target.value }))}
                rows={4}
              />
              <MacroPicker
                section="footer"
                currentText={formData.physical_examination_note || ''}
                onInsert={(text) => setFormData(prev => ({ ...prev, physical_examination_note: text }))}
              />
            </CardContent>
          </Card>

          {/* Discussion Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                DISCUSSION{' '}
                <span className="text-sm font-normal text-slate-500">(exported as bold centered section header)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Discussion, conclusions, recommendations, attorney notes..."
                value={formData.discussion_note || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, discussion_note: e.target.value }))}
                rows={4}
              />
              <MacroPicker
                section="footer"
                currentText={formData.discussion_note || ''}
                onInsert={(text) => setFormData(prev => ({ ...prev, discussion_note: text }))}
              />
            </CardContent>
          </Card>
        </div>
        )}

        </>

        <div className="flex justify-end gap-3 pt-4 border-t sticky bottom-0 bg-white z-10">
          <Button variant="outline" onClick={onClose}>
            <X className="w-4 h-4 mr-2" />
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isLoading}
            className="bg-gradient-to-r from-green-600 to-emerald-600"
          >
            <Save className="w-4 h-4 mr-2" />
            Save Summary
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}